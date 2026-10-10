import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, link, mkdir, open, readFile, realpath, rename, unlink, } from 'node:fs/promises';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { valid as validSemver } from 'semver';
import { resolvePackageRoot } from "./package-root.js";
export const DEFAULT_REGISTRY_URL = 'https://grasdouble.github.io/Lufa-AI/registry/catalog-index.json';
const packageRoot = resolvePackageRoot(import.meta.url);
const bundledIndexPath = path.join(packageRoot, 'generated', 'catalog-index.json');
const cacheFileName = 'catalog-index-cache.json';
const requestTimeoutMs = 3_000;
const maxIndexBytes = 5 * 1024 * 1024;
const maxArtifactFileBytes = 2 * 1024 * 1024;
const maxArtifactBytes = 10 * 1024 * 1024;
const allowedArtifactContentTypes = new Set([
    'text/markdown',
    'text/plain',
    'application/octet-stream',
]);
const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
});
const artifactSchema = JSON.parse(await readFile(path.join(packageRoot, 'schemas', 'artifact.schema.json'), 'utf8'));
const registryArtifactSchema = structuredClone(artifactSchema);
registryArtifactSchema.$defs.file.properties.sha256 = {
    type: 'string',
    pattern: '^[a-f0-9]{64}$',
};
const validateArtifact = ajv.compile(registryArtifactSchema);
export class RegistryIndexError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RegistryIndexError';
    }
}
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isValidUtcDateTime(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
    if (!match)
        return false;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    if (year === 0 ||
        month < 1 ||
        month > 12 ||
        hour > 23 ||
        minute > 59 ||
        second > 59) {
        return false;
    }
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [
        31,
        leapYear ? 29 : 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    return day >= 1 && day <= daysInMonth[month - 1];
}
function assertSafeRelativePath(value, label) {
    const segments = value.split('/');
    if (value.length === 0 ||
        value.includes('\\') ||
        value.includes(':') ||
        value.includes('\0') ||
        path.posix.isAbsolute(value) ||
        path.win32.isAbsolute(value) ||
        /^[a-zA-Z]:/.test(value) ||
        segments.some((segment) => segment.length === 0 ||
            segment === '.' ||
            segment === '..' ||
            /[. ]$/.test(segment) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)) ||
        path.posix.normalize(value) !== value) {
        throw new RegistryIndexError(`${label} contient un chemin dangereux.`);
    }
}
function validateArtifactMetadata(artifact) {
    const seenVersions = new Set();
    for (const version of artifact.versions) {
        if (validSemver(version.version) !== version.version) {
            throw new RegistryIndexError(`${artifact.id} contient une version SemVer invalide.`);
        }
        if (seenVersions.has(version.version)) {
            throw new RegistryIndexError(`${artifact.id} contient une version dupliquée.`);
        }
        seenVersions.add(version.version);
        if (!isValidUtcDateTime(version.publishedAt)) {
            throw new RegistryIndexError(`${artifact.id}@${version.version} contient une date de publication invalide.`);
        }
        const environments = new Set();
        for (const compatibility of version.compatibilities) {
            if (environments.has(compatibility.environment)) {
                throw new RegistryIndexError(`${artifact.id}@${version.version} contient une compatibilité dupliquée.`);
            }
            environments.add(compatibility.environment);
            if (compatibility.level === 'verified' &&
                (!compatibility.evidence ||
                    !compatibility.evidence.testedVersion.trim() ||
                    !compatibility.evidence.method.trim() ||
                    !compatibility.evidence.reference.trim())) {
                throw new RegistryIndexError(`${artifact.id}@${version.version} a une preuve de compatibilité invalide.`);
            }
        }
        const sourcePaths = new Set();
        const destinations = new Set();
        for (const file of version.files) {
            assertSafeRelativePath(file.path, `${artifact.id}@${version.version}`);
            if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
                throw new RegistryIndexError(`${artifact.id}@${version.version} contient une empreinte SHA-256 invalide.`);
            }
            assertSafeRelativePath(file.destination, `${artifact.id}@${version.version}`);
            if (sourcePaths.has(file.path) || destinations.has(file.destination)) {
                throw new RegistryIndexError(`${artifact.id}@${version.version} contient un fichier ou une destination dupliqué(e).`);
            }
            sourcePaths.add(file.path);
            destinations.add(file.destination);
        }
    }
}
export function validateCatalogIndex(value) {
    if (!isObject(value) ||
        Object.keys(value).sort().join(',') !== 'artifacts,schemaVersion' ||
        value.schemaVersion !== 2 ||
        !Array.isArray(value.artifacts) ||
        value.artifacts.length === 0) {
        throw new RegistryIndexError('Structure d’index invalide (schemaVersion 2 requis).');
    }
    const ids = new Set();
    for (const candidate of value.artifacts) {
        if (!validateArtifact(candidate)) {
            const hashFailure = validateArtifact.errors?.find((error) => error.instancePath.endsWith('/sha256') &&
                (error.keyword === 'pattern' || error.keyword === 'type'));
            if (hashFailure) {
                throw new RegistryIndexError('Une empreinte SHA-256 publiée doit être une chaîne hexadécimale minuscule de 64 caractères.');
            }
            throw new RegistryIndexError(`Métadonnées d’artefact invalides : ${ajv.errorsText(validateArtifact.errors)}.`);
        }
        const artifact = candidate;
        if (ids.has(artifact.id)) {
            throw new RegistryIndexError(`Identifiant dupliqué « ${artifact.id} ».`);
        }
        ids.add(artifact.id);
        validateArtifactMetadata(artifact);
    }
    return value;
}
function parseAndValidate(raw, label) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new RegistryIndexError(`${label} n’est pas un JSON valide.`);
    }
    try {
        return validateCatalogIndex(value);
    }
    catch (error) {
        throw new RegistryIndexError(`${label} est invalide : ${error instanceof Error ? error.message : String(error)}`);
    }
}
export function getRegistryCacheDirectory(env = process.env, platform = process.platform, homeDirectory = os.homedir()) {
    if (env.LUFA_CACHE_DIR)
        return path.resolve(env.LUFA_CACHE_DIR);
    if (platform === 'win32') {
        return path.join(env.LOCALAPPDATA || path.join(homeDirectory, 'AppData', 'Local'), 'lufa-ai', 'cache');
    }
    if (env.XDG_CACHE_HOME)
        return path.join(env.XDG_CACHE_HOME, 'lufa-ai');
    if (platform === 'darwin') {
        return path.join(homeDirectory, 'Library', 'Caches', 'lufa-ai');
    }
    return path.join(homeDirectory, '.cache', 'lufa-ai');
}
async function canonicalizeSystemVar(directory) {
    const resolved = path.resolve(directory);
    if (process.platform !== 'darwin' ||
        (resolved !== '/var' && !resolved.startsWith('/var/'))) {
        return resolved;
    }
    const varPath = await lstat('/var').catch((error) => {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    });
    if (!varPath?.isSymbolicLink())
        return resolved;
    const canonicalVarPath = await realpath('/var');
    if (canonicalVarPath !== '/private/var') {
        throw new RegistryIndexError('Le lien symbolique système /var ne pointe pas vers /private/var.');
    }
    return path.join('/private/var', resolved.slice('/var'.length));
}
async function inspectCacheDirectory(directory, createMissing) {
    const canonicalDirectory = await canonicalizeSystemVar(directory);
    const root = path.parse(canonicalDirectory).root;
    const segments = canonicalDirectory.slice(root.length).split(path.sep);
    let current = root;
    for (const segment of segments) {
        if (!segment)
            continue;
        current = path.join(current, segment);
        let details;
        try {
            details = await lstat(current);
        }
        catch (error) {
            if (error.code !== 'ENOENT' ||
                !createMissing) {
                throw error;
            }
            await mkdir(current, { mode: 0o700 });
            details = await lstat(current);
        }
        if (details.isSymbolicLink()) {
            throw new RegistryIndexError(`Le chemin du cache contient un lien symbolique : ${current}.`);
        }
        if (!details.isDirectory()) {
            throw new RegistryIndexError(`Un composant du chemin du cache n’est pas un dossier : ${current}.`);
        }
    }
    return canonicalDirectory;
}
async function inspectCacheFile(cachePath, checkSize) {
    let details;
    try {
        details = await lstat(cachePath);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
    if (details.isSymbolicLink()) {
        throw new RegistryIndexError(`Le fichier de cache est un lien symbolique : ${cachePath}.`);
    }
    if (!details.isFile() || details.nlink !== 1) {
        throw new RegistryIndexError(`Le fichier de cache n’est pas un fichier ordinaire isolé : ${cachePath}.`);
    }
    if (checkSize && details.size > maxIndexBytes) {
        throw new RegistryIndexError(`Le cache d’index dépasse la taille autorisée de ${maxIndexBytes} octets.`);
    }
    return true;
}
async function readCache() {
    try {
        const directory = await inspectCacheDirectory(getRegistryCacheDirectory(), false);
        const cachePath = path.join(directory, cacheFileName);
        if (!(await inspectCacheFile(cachePath, true)))
            return null;
        const checked = await lstat(cachePath);
        const handle = await open(cachePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let raw;
        try {
            const opened = await handle.stat();
            if (!opened.isFile() ||
                opened.nlink !== 1 ||
                opened.dev !== checked.dev ||
                opened.ino !== checked.ino ||
                opened.size > maxIndexBytes) {
                throw new RegistryIndexError('Le fichier de cache a changé ou dépasse la taille autorisée.');
            }
            raw = await handle.readFile('utf8');
        }
        finally {
            await handle.close();
        }
        const parsed = JSON.parse(raw);
        if (!isObject(parsed) ||
            Object.keys(parsed).sort().join(',') !== 'cachedAt,index' ||
            typeof parsed.cachedAt !== 'string' ||
            !Number.isFinite(Date.parse(parsed.cachedAt)) ||
            !parsed.cachedAt.endsWith('Z') ||
            new Date(parsed.cachedAt).toISOString() !== parsed.cachedAt) {
            throw new RegistryIndexError('Métadonnées de cache invalides.');
        }
        return {
            index: validateCatalogIndex(parsed.index),
            cachedAt: parsed.cachedAt,
        };
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        if (error instanceof RegistryIndexError) {
            process.stderr.write(`Cache d’index ignoré : ${error.message}\n`);
        }
        else if (error.code !== 'ENOENT') {
            process.stderr.write('Cache d’index illisible ; il sera ignoré.\n');
        }
        return null;
    }
}
async function writeCache(index) {
    const directory = await inspectCacheDirectory(getRegistryCacheDirectory(), true);
    const cachePath = path.join(directory, cacheFileName);
    const serialized = `${JSON.stringify({ cachedAt: new Date().toISOString(), index })}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > maxIndexBytes) {
        throw new RegistryIndexError(`L’index dépasse la taille de cache autorisée de ${maxIndexBytes} octets.`);
    }
    await inspectCacheFile(cachePath, false);
    const temporaryPath = path.join(directory, `.catalog-index-${randomUUID()}.tmp`);
    let committed = false;
    try {
        const handle = await open(temporaryPath, 'wx', 0o600);
        try {
            await handle.writeFile(serialized, 'utf8');
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        const staged = await lstat(temporaryPath);
        if (staged.isSymbolicLink() || !staged.isFile() || staged.nlink !== 1) {
            throw new RegistryIndexError('Le fichier temporaire du cache a changé de type avant son renommage.');
        }
        await inspectCacheDirectory(directory, false);
        await inspectCacheFile(cachePath, false);
        await rename(temporaryPath, cachePath);
        committed = true;
    }
    finally {
        if (!committed)
            await unlink(temporaryPath).catch(() => undefined);
    }
}
export function getRegistryUrl(value = process.env.LUFA_REGISTRY_URL) {
    const url = new URL(value || DEFAULT_REGISTRY_URL);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') ||
        url.username ||
        url.password) {
        throw new RegistryIndexError('LUFA_REGISTRY_URL doit être une URL HTTP(S) sans identifiants.');
    }
    if (url.protocol === 'http:') {
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const isLoopback = hostname === 'localhost' ||
            (isIP(hostname) === 4 && hostname.startsWith('127.')) ||
            (isIP(hostname) === 6 && hostname === '::1');
        if (!isLoopback) {
            throw new RegistryIndexError('HTTP non chiffré est autorisé uniquement vers localhost ou une adresse loopback.');
        }
    }
    return url;
}
function blobPath(directory, sha256) {
    return path.join(directory, 'contents', 'sha256', sha256.slice(0, 2), sha256);
}
async function readVerifiedBlob(cacheDirectory, sha256) {
    const filename = blobPath(cacheDirectory, sha256);
    if (!(await inspectCacheFile(filename, false)))
        return undefined;
    const before = await lstat(filename);
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let contents;
    try {
        const opened = await handle.stat();
        if (!opened.isFile() ||
            opened.nlink !== 1 ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            opened.size > maxArtifactFileBytes) {
            throw new RegistryIndexError(`Contenu du cache dangereux ou trop volumineux : ${filename}.`);
        }
        contents = await handle.readFile();
    }
    finally {
        await handle.close();
    }
    if (createHash('sha256').update(contents).digest('hex') !== sha256) {
        throw new RegistryIndexError(`Contenu corrompu dans le cache (${sha256}) ; supprimez ce fichier de cache après vérification.`);
    }
    return contents;
}
async function writeVerifiedBlob(cacheDirectory, sha256, contents) {
    const target = blobPath(cacheDirectory, sha256);
    const directory = path.dirname(target);
    await inspectCacheDirectory(directory, true);
    const temporary = path.join(directory, `.content-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    let identity;
    let committed = false;
    try {
        const details = await handle.stat();
        identity = { dev: details.dev, ino: details.ino };
        await handle.writeFile(contents);
        await handle.sync();
        await handle.close();
        const staged = await lstat(temporary);
        if (!staged.isFile() ||
            staged.nlink !== 1 ||
            staged.dev !== identity.dev ||
            staged.ino !== identity.ino) {
            throw new RegistryIndexError('Le contenu temporaire du cache a changé avant son enregistrement.');
        }
        try {
            await link(temporary, target);
            committed = true;
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const existing = await readVerifiedBlob(cacheDirectory, sha256);
            if (!existing)
                throw error;
        }
    }
    finally {
        await handle.close().catch(() => undefined);
        if (identity) {
            const current = await lstat(temporary).catch((error) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
            if (current?.isFile() &&
                current.dev === identity.dev &&
                current.ino === identity.ino) {
                const targetDetails = committed ? await lstat(target) : undefined;
                const safeTemporaryLink = current.nlink === 1 ||
                    (committed &&
                        current.nlink === 2 &&
                        targetDetails?.dev === identity.dev &&
                        targetDetails.ino === identity.ino);
                if (safeTemporaryLink)
                    await unlink(temporary);
            }
        }
        if (committed) {
            await inspectCacheFile(target, false);
        }
    }
}
async function readBundledFile(filePath) {
    const absolute = path.join(packageRoot, 'catalog', ...filePath.split('/'));
    let current = path.join(packageRoot, 'catalog');
    try {
        for (const segment of filePath.split('/')) {
            current = path.join(current, segment);
            const details = await lstat(current);
            if (details.isSymbolicLink()) {
                throw new RegistryIndexError(`Fichier de l’instantané symbolique interdit : ${filePath}.`);
            }
        }
        const details = await lstat(absolute);
        if (!details.isFile() || details.nlink !== 1) {
            throw new RegistryIndexError(`Fichier de l’instantané non ordinaire : ${filePath}.`);
        }
        return await readFile(absolute);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
async function fetchArtifactFile(url) {
    let response;
    try {
        response = await fetch(url, {
            method: 'GET',
            headers: { accept: 'application/octet-stream, */*;q=0.1' },
            signal: AbortSignal.timeout(requestTimeoutMs),
            redirect: 'error',
            cache: 'no-store',
        });
    }
    catch {
        throw new RegistryIndexError(`Téléchargement impossible pour ${url.pathname} (délai dépassé, réseau indisponible ou redirection refusée).`);
    }
    if (response.status !== 200) {
        throw new RegistryIndexError(`Le registre a répondu HTTP ${response.status} pour ${url.pathname}.`);
    }
    const contentType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
    if (!contentType || !allowedArtifactContentTypes.has(contentType)) {
        throw new RegistryIndexError(`Content-Type refusé pour ${url.pathname} : « ${contentType ?? 'absent'} ». MIME autorisés : text/markdown, text/plain, application/octet-stream.`);
    }
    const lengthHeader = response.headers.get('content-length');
    if (lengthHeader &&
        (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > maxArtifactFileBytes)) {
        throw new RegistryIndexError(`Fichier distant trop volumineux ou Content-Length invalide : ${url.pathname}.`);
    }
    const reader = response.body?.getReader();
    if (!reader)
        throw new RegistryIndexError(`Réponse vide pour ${url.pathname}.`);
    const chunks = [];
    let totalBytes = 0;
    while (true) {
        let result;
        try {
            result = await reader.read();
        }
        catch {
            throw new RegistryIndexError(`Réponse incomplète pour ${url.pathname}.`);
        }
        if (result.done)
            break;
        totalBytes += result.value.byteLength;
        if (totalBytes > maxArtifactFileBytes) {
            await reader.cancel();
            throw new RegistryIndexError(`Fichier distant trop volumineux (maximum ${maxArtifactFileBytes} octets) : ${url.pathname}.`);
        }
        chunks.push(Buffer.from(result.value));
    }
    return Buffer.concat(chunks);
}
export async function fetchVerifiedArtifactFiles(artifactId, version, files, allowBundledFallback = false) {
    const cacheDirectory = await inspectCacheDirectory(getRegistryCacheDirectory(), true);
    const registryUrl = getRegistryUrl();
    const base = new URL('./', registryUrl);
    const results = new Map();
    const pendingBlobs = new Map();
    let totalBytes = 0;
    for (const file of files) {
        assertSafeRelativePath(file.path, `${artifactId}@${version}`);
        if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
            throw new RegistryIndexError(`Empreinte SHA-256 invalide pour ${artifactId}@${version}/${file.path}.`);
        }
        const cachedContents = await readVerifiedBlob(cacheDirectory, file.sha256);
        let contents = cachedContents;
        if (!contents) {
            if (allowBundledFallback) {
                contents = await readBundledFile(`${artifactId}/${file.path}`);
                if (contents &&
                    createHash('sha256').update(contents).digest('hex') !== file.sha256) {
                    contents = undefined;
                }
            }
            if (!contents) {
                const segments = ['catalog', artifactId, ...file.path.split('/')];
                const url = new URL(segments.map(encodeURIComponent).join('/'), base);
                try {
                    contents = await fetchArtifactFile(url);
                }
                catch (error) {
                    throw new RegistryIndexError(`${error instanceof Error ? error.message : String(error)} Le contenu exact est absent du cache ; réessayez avec une connexion réseau disponible.`);
                }
            }
            if (createHash('sha256').update(contents).digest('hex') !== file.sha256) {
                throw new RegistryIndexError(`Checksum SHA-256 invalide pour ${artifactId}@${version}/${file.path} ; aucun contenu non vérifié n’a été mis en cache ou écrit dans le projet.`);
            }
        }
        if (contents.byteLength > maxArtifactFileBytes) {
            throw new RegistryIndexError(`Fichier ${artifactId}@${version}/${file.path} dépasse ${maxArtifactFileBytes} octets.`);
        }
        totalBytes += contents.byteLength;
        if (totalBytes > maxArtifactBytes) {
            throw new RegistryIndexError(`L’artefact ${artifactId}@${version} dépasse la limite totale de ${maxArtifactBytes} octets.`);
        }
        if (!cachedContents)
            pendingBlobs.set(file.sha256, contents);
        results.set(file.path, contents);
    }
    // Do not persist any newly downloaded bytes until every file in this exact
    // artifact/version has been received and its published digest has passed.
    for (const [sha256, contents] of pendingBlobs) {
        await writeVerifiedBlob(cacheDirectory, sha256, contents);
    }
    process.stderr.write(`Contenus exacts ${artifactId}@${version} : cache local vérifié (${totalBytes} octets) ; utilisables hors ligne.\n`);
    return results;
}
async function fetchRemoteIndex() {
    const url = getRegistryUrl();
    const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(requestTimeoutMs),
        redirect: 'error',
        cache: 'no-store',
    });
    if (response.status !== 200) {
        throw new RegistryIndexError(`Le registre a répondu HTTP ${response.status}.`);
    }
    const contentType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
    if (contentType !== 'application/json') {
        throw new RegistryIndexError('Le registre n’a pas renvoyé un index de type application/json.');
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxIndexBytes) {
        throw new RegistryIndexError('L’index distant dépasse la taille autorisée.');
    }
    const reader = response.body?.getReader();
    if (!reader)
        throw new RegistryIndexError('Réponse HTTP vide.');
    const chunks = [];
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        totalBytes += value.byteLength;
        if (totalBytes > maxIndexBytes) {
            await reader.cancel();
            throw new RegistryIndexError('L’index distant dépasse la taille autorisée.');
        }
        chunks.push(Buffer.from(value));
    }
    return parseAndValidate(Buffer.concat(chunks).toString('utf8'), 'Index distant');
}
export async function resolveCatalogIndex() {
    let remoteFailure;
    try {
        const index = await fetchRemoteIndex();
        try {
            await writeCache(index);
        }
        catch {
            process.stderr.write('Index distant actualisé, mais le cache local n’a pas pu être écrit.\n');
        }
        process.stderr.write(`Index du registre : distant actualisé le ${new Date().toISOString()}.\n`);
        return { index, source: 'remote' };
    }
    catch (error) {
        remoteFailure = error instanceof Error ? error.message : String(error);
    }
    const cached = await readCache();
    if (cached) {
        process.stderr.write(`AVERTISSEMENT : registre indisponible (${remoteFailure}) ; index du cache du ${cached.cachedAt}, potentiellement périmé.\n`);
        return { index: cached.index, source: 'cache' };
    }
    const bundled = parseAndValidate(await readFile(bundledIndexPath, 'utf8'), 'Instantané embarqué');
    process.stderr.write(`AVERTISSEMENT : registre indisponible (${remoteFailure}) et aucun cache valide ; utilisation de l’instantané embarqué, potentiellement périmé.\n`);
    return { index: bundled, source: 'bundled' };
}
