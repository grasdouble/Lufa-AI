import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { valid as validSemver, rcompare } from 'semver';
import { loadCatalog } from './catalog.ts';

type InstallFile = { path: string; destination: string };
type ArtifactVersion = { version: string; files: InstallFile[] };
type Artifact = {
  id: string;
  type: string;
  provenance: { repository: string };
  versions: ArtifactVersion[];
};
export type LockedFile = { path: string; sha256: string };
export type LockEntry = {
  id: string;
  version: string;
  target: string;
  source: string;
  files: LockedFile[];
};
export type LockFile = { schemaVersion: 1; installs: LockEntry[] };
type PlannedFile = {
  path: string;
  sourcePath: string;
  destinationPath: string;
  contents: Buffer;
  sha256: string;
};
type FileIdentity = { device: number; inode: number };
type CreatedFile = {
  parentSegments: string[];
  parentIdentities: FileIdentity[];
  basename: string;
  device: number;
  inode: number;
};
type CreatedDirectory = {
  name: string;
  created: boolean;
  identity: FileIdentity;
  parentIdentity: FileIdentity;
};
type ReleaseProjectLock = () => Promise<void>;

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const targetDirectory = '.agents/skills';
const lockName = 'lufa.lock.json';
const installLockName = '.lufa.install.lock';
const installLockWaitLimitMs = 30_000;
let processCwdQueue = Promise.resolve();

class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function assertSafeRelativePath(value: string, label: string): void {
  const segments = value.split('/');
  if (
    value.length === 0 ||
    value.includes('\\') ||
    value.includes(':') ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        /[. ]$/.test(segment) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment),
    ) ||
    path.posix.normalize(value) !== value
  ) {
    throw new InstallError(
      `${label} contient un chemin dangereux : « ${value} ».`,
    );
  }
}

function parseInstallArgs(args: string[]): {
  specifier: string;
  project: string;
  confirmed: boolean;
} {
  const positional: string[] = [];
  let project = process.cwd();
  let confirmed = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--yes' || argument === '--non-interactive') {
      confirmed = true;
    } else if (argument === '--project') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new InstallError('L’option --project attend un chemin.');
      }
      project = path.resolve(value);
      index += 1;
    } else if (argument.startsWith('-')) {
      throw new InstallError(`Option inconnue « ${argument} » pour install.`);
    } else {
      positional.push(argument);
    }
  }
  if (positional.length !== 1) {
    throw new InstallError(
      'Usage : lufa install <identifiant[@version]> [--project <chemin>] [--yes|--non-interactive]',
    );
  }
  return { specifier: positional[0]!, project, confirmed };
}

function parseSpecifier(specifier: string): { id: string; version?: string } {
  const separator = specifier.indexOf('@');
  const id = separator < 0 ? specifier : specifier.slice(0, separator);
  const version = separator < 0 ? undefined : specifier.slice(separator + 1);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new InstallError(`Identifiant d’artefact invalide « ${id} ».`);
  }
  if (version !== undefined && validSemver(version) !== version) {
    throw new InstallError(`Version SemVer invalide « ${version} ».`);
  }
  return { id, version };
}

function validateLock(value: unknown): LockFile {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('installs' in value) ||
    !Array.isArray(value.installs)
  ) {
    throw new InstallError(
      `Le format de ${lockName} est invalide ; aucune écriture effectuée.`,
    );
  }

  const ids = new Set<string>();
  const destinations = new Set<string>();
  for (const entry of value.installs) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('id' in entry) ||
      typeof entry.id !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) ||
      !('version' in entry) ||
      typeof entry.version !== 'string' ||
      validSemver(entry.version) !== entry.version ||
      !('target' in entry) ||
      entry.target !== targetDirectory ||
      !('source' in entry) ||
      typeof entry.source !== 'string' ||
      !('files' in entry) ||
      !Array.isArray(entry.files) ||
      ids.has(entry.id)
    ) {
      throw new InstallError(
        `Le format de ${lockName} est invalide ; aucune écriture effectuée.`,
      );
    }
    ids.add(entry.id);
    for (const file of entry.files) {
      if (
        typeof file !== 'object' ||
        file === null ||
        !('path' in file) ||
        typeof file.path !== 'string' ||
        !('sha256' in file) ||
        typeof file.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(file.sha256)
      ) {
        throw new InstallError(
          `Le format de ${lockName} est invalide ; aucune écriture effectuée.`,
        );
      }
      assertSafeRelativePath(file.path, lockName);
      if (!file.path.startsWith(`${targetDirectory}/${entry.id}/`)) {
        throw new InstallError(
          `Le chemin « ${file.path} » ne correspond pas à la cible verrouillée de « ${entry.id} ».`,
        );
      }
      if (destinations.has(file.path)) {
        throw new InstallError(
          `Le chemin « ${file.path} » est attribué plusieurs fois dans ${lockName}.`,
        );
      }
      destinations.add(file.path);
    }
  }
  return value as LockFile;
}

export async function readLock(projectRoot: string): Promise<LockFile> {
  const lockPath = path.join(projectRoot, lockName);
  try {
    const details = await lstat(lockPath);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new InstallError(
        `${lockName} doit être un fichier ordinaire, pas un lien symbolique.`,
      );
    }
    return validateLock(
      JSON.parse(await readFile(lockPath, 'utf8')) as unknown,
    );
  } catch (error) {
    if (error instanceof InstallError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: 1, installs: [] };
    }
    throw new InstallError(
      `${lockName} est illisible ou invalide ; aucune écriture effectuée.`,
    );
  }
}

export async function acquireProjectLock(
  projectRoot: string,
  onWait?: () => void,
): Promise<ReleaseProjectLock> {
  const lockPath = path.join(projectRoot, installLockName);
  const startedAt = Date.now();
  let waitNotified = false;
  while (true) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let identity: { dev: number; ino: number } | undefined;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      const lockIdentity = await handle.stat();
      identity = lockIdentity;
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      );
      await handle.sync();
      await handle.close();
      return async () => {
        try {
          const current = await lstat(lockPath);
          if (
            current.isFile() &&
            current.dev === lockIdentity.dev &&
            current.ino === lockIdentity.ino
          ) {
            await unlink(lockPath);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
        // Do not remove a lock file unless it is the file created by this attempt.
        if (identity) {
          const current = await lstat(lockPath).catch(() => undefined);
          if (current?.dev === identity.dev && current.ino === identity.ino) {
            await unlink(lockPath).catch(() => undefined);
          }
        }
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!waitNotified) {
        waitNotified = true;
        onWait?.();
      }
      if (Date.now() - startedAt >= installLockWaitLimitMs) {
        throw new InstallError(
          `Délai d’attente dépassé pour le verrou d’installation « ${installLockName} ». Il peut être périmé après un arrêt brutal ; vérifiez qu’aucune installation Lufa n’est active avant de le supprimer manuellement.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export async function ensureProjectRoot(project: string): Promise<string> {
  let projectStat;
  try {
    projectStat = await lstat(project);
  } catch {
    throw new InstallError(`Le projet cible « ${project} » n’existe pas.`);
  }
  if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) {
    throw new InstallError(
      'Le projet cible doit être un dossier réel, pas un lien symbolique.',
    );
  }
  return realpath(project);
}

async function readSourceFile(
  catalogRoot: string,
  id: string,
  relativeSource: string,
): Promise<{ sourcePath: string; contents: Buffer }> {
  assertSafeRelativePath(relativeSource, 'Source du catalogue');
  const canonicalCatalogRoot = await realpath(
    path.join(catalogRoot, 'catalog'),
  );
  let current = path.join(catalogRoot, 'catalog');
  const sourceSegments = [id, ...relativeSource.split('/')];
  for (const segment of sourceSegments) {
    current = path.join(current, segment);
    const details = await lstat(current);
    if (details.isSymbolicLink()) {
      throw new InstallError(`Source symbolique interdite : « ${current} ».`);
    }
  }
  const sourcePath = await realpath(current);
  const details = await lstat(sourcePath);
  if (!details.isFile() || !isWithin(canonicalCatalogRoot, sourcePath)) {
    throw new InstallError(
      `Le fichier source « ${relativeSource} » est absent ou hors du catalogue.`,
    );
  }
  return { sourcePath, contents: await readFile(sourcePath) };
}

async function inspectDestinationParents(
  projectRoot: string,
  relativePath: string,
): Promise<boolean> {
  const segments = relativePath.split('/');
  let current = projectRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink()) {
        throw new InstallError(
          `Lien symbolique interdit dans la destination : « ${current} ».`,
        );
      }
      if (!details.isDirectory()) {
        throw new InstallError(
          `Un élément non-dossier bloque la destination « ${current} ».`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  const destination = path.join(projectRoot, ...segments);
  try {
    const details = await lstat(destination);
    if (details.isSymbolicLink()) {
      throw new InstallError(
        `Lien symbolique interdit à la destination « ${relativePath} ».`,
      );
    }
    if (!details.isFile()) {
      throw new InstallError(
        `La destination « ${relativePath} » n’est pas un fichier ordinaire.`,
      );
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function confirmInstall(confirmed: boolean): Promise<boolean> {
  if (confirmed) return true;
  if (!stdin.isTTY) {
    throw new InstallError(
      'Installation non interactive : confirmer explicitement avec --yes ou --non-interactive.',
    );
  }
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question('Installer ces fichiers ? [o/N] ');
    return /^(o|oui|y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

async function assertCurrentDirectory(expected: string): Promise<void> {
  const actual = await realpath('.');
  if (actual !== expected) {
    throw new InstallError(
      `Le répertoire de travail ancré a changé (« ${actual} » au lieu de « ${expected} ») ; écriture annulée.`,
    );
  }
}

async function currentDirectoryIdentity(): Promise<FileIdentity> {
  const details = await lstat('.');
  if (!details.isDirectory()) {
    throw new InstallError('Le CWD ancré n’est plus un répertoire ordinaire.');
  }
  return { device: details.dev, inode: details.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function identityFromStats(details: {
  dev: number;
  ino: number;
}): FileIdentity {
  return { device: details.dev, inode: details.ino };
}

async function enterVerifiedDirectory(
  name: string,
  expectedPath: string,
): Promise<CreatedDirectory> {
  const parentIdentity = await currentDirectoryIdentity();
  let created = false;
  try {
    await mkdir(name);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const details = await lstat(name);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new InstallError(
      `Répertoire de destination dangereux : « ${name} ».`,
    );
  }
  process.chdir(name);
  await assertCurrentDirectory(expectedPath);
  return {
    name,
    created,
    identity: await currentDirectoryIdentity(),
    parentIdentity,
  };
}

export async function withProcessCwdLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = processCwdQueue;
  let release!: () => void;
  processCwdQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function writeFileFromAnchoredDirectory(
  file: PlannedFile,
  relativeSegments: string[],
  idRoot: string,
  onBeforeCommit: InstallOptions['onBeforeFileCommit'],
  onAfterCwdCheckBeforeWrite: InstallOptions['onAfterCwdCheckBeforeWrite'],
  createdFiles: CreatedFile[],
): Promise<void> {
  const parentSegments = relativeSegments.slice(0, -1);
  const basename = relativeSegments.at(-1)!;
  let depth = 0;
  let canAscend = true;
  let temporaryName: string | undefined;
  let temporaryIdentity: FileIdentity | undefined;
  let committedIdentity: { device: number; inode: number } | undefined;
  let operationError: unknown;
  let temporaryCleanupError: Error | undefined;
  const parentIdentities: FileIdentity[] = [];
  let expectedParent = idRoot;
  try {
    for (const segment of parentSegments) {
      try {
        await mkdir(segment);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const details = await lstat(segment);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new InstallError(
          `Répertoire imbriqué dangereux dans la destination : « ${segment} ».`,
        );
      }
      process.chdir(segment);
      depth += 1;
      expectedParent = path.join(expectedParent, segment);
      try {
        await assertCurrentDirectory(expectedParent);
        parentIdentities.push(await currentDirectoryIdentity());
      } catch (error) {
        canAscend = false;
        throw error;
      }
    }

    await assertCurrentDirectory(expectedParent);
    await onBeforeCommit?.(file.path);
    // Recheck after validation hooks. The operations below use basenames only;
    // they resolve from the CWD directory object entered and checked above.
    await assertCurrentDirectory(expectedParent);
    await onAfterCwdCheckBeforeWrite?.(file.path);

    temporaryName = `.lufa-${randomUUID()}.tmp`;
    const handle = await open(temporaryName, 'wx', 0o666);
    try {
      const temporaryDetails = await handle.stat();
      temporaryIdentity = {
        device: temporaryDetails.dev,
        inode: temporaryDetails.ino,
      };
      await handle.writeFile(file.contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const stagedDetails = await lstat(temporaryName);
    if (
      !temporaryIdentity ||
      stagedDetails.dev !== temporaryIdentity.device ||
      stagedDetails.ino !== temporaryIdentity.inode ||
      !stagedDetails.isFile()
    ) {
      throw new InstallError(
        'Le fichier de staging a été remplacé ; abandon sûr.',
      );
    }
    await link(temporaryName, basename);
    const committedDetails = await lstat(basename);
    if (
      !committedDetails.isFile() ||
      !temporaryIdentity ||
      !sameIdentity(identityFromStats(committedDetails), temporaryIdentity)
    ) {
      throw new InstallError(
        `La destination « ${file.path} » ne correspond pas au staging créé ; elle peut contenir un fichier concurrent et reste intacte pour inspection.`,
      );
    }
    committedIdentity = {
      device: committedDetails.dev,
      inode: committedDetails.ino,
    };
    await assertCurrentDirectory(expectedParent);
    createdFiles.push({
      parentSegments,
      parentIdentities,
      basename,
      ...committedIdentity,
    });
  } catch (error) {
    let cleanupWarning = '';
    if (committedIdentity) {
      try {
        const current = await lstat(basename);
        if (
          current.isFile() &&
          sameIdentity(identityFromStats(current), committedIdentity)
        ) {
          await unlink(basename);
        } else {
          cleanupWarning = `La destination « ${file.path} » a changé d’identité et reste intacte pour inspection.`;
        }
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          cleanupWarning = `La destination « ${file.path} » n’a pas pu être vérifiée pendant le nettoyage.`;
        }
      }
    }
    operationError = new InstallError(
      `${error instanceof Error ? error.message : String(error)}${cleanupWarning ? ` ${cleanupWarning}` : ''}`,
    );
  } finally {
    try {
      if (temporaryName) {
        const staged = await lstat(temporaryName).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          },
        );
        if (staged) {
          if (
            temporaryIdentity &&
            staged.isFile() &&
            sameIdentity(identityFromStats(staged), temporaryIdentity)
          ) {
            await unlink(temporaryName);
          } else {
            temporaryCleanupError = new InstallError(
              `Le staging « ${temporaryName} » reste présent mais son identité est incertaine ; il n’a pas été supprimé.`,
            );
          }
        }
      }
    } catch (error) {
      temporaryCleanupError =
        error instanceof Error ? error : new Error(String(error));
    } finally {
      if (canAscend) {
        for (let index = 0; index < depth; index += 1) process.chdir('..');
      }
    }
  }
  if (temporaryCleanupError) {
    const originalMessage =
      operationError instanceof Error
        ? operationError.message
        : operationError === undefined
          ? ''
          : String(operationError);
    throw new InstallError(
      `${originalMessage}${originalMessage ? ' ' : ''}${temporaryCleanupError.message}`,
    );
  }
  if (operationError !== undefined) throw operationError;
}

async function rollbackFromAnchoredDirectory(
  projectRoot: string,
  anchorIdentity: FileIdentity,
  createdFiles: CreatedFile[],
): Promise<{ removed: number; residual: number; blocked?: string }> {
  let removed = 0;
  let residual = 0;
  let blocked: string | undefined;
  const files = [...createdFiles].reverse();
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    let depth = 0;
    let canAscend = true;
    try {
      const anchorPath = await realpath('.');
      if (
        !isWithin(projectRoot, anchorPath) ||
        !sameIdentity(await currentDirectoryIdentity(), anchorIdentity)
      ) {
        blocked = `le répertoire ancré n’est plus identifiable sous le projet (${anchorPath})`;
        residual += files.length - index;
        break;
      }

      for (
        let parentIndex = 0;
        parentIndex < file.parentSegments.length;
        parentIndex += 1
      ) {
        const segment = file.parentSegments[parentIndex]!;
        const details = await lstat(segment);
        if (details.isSymbolicLink() || !details.isDirectory()) {
          blocked = `parent remplacé pendant le rollback (« ${segment} »)`;
          throw new InstallError(blocked);
        }
        process.chdir(segment);
        depth += 1;
        const currentPath = await realpath('.');
        if (
          !isWithin(projectRoot, currentPath) ||
          !sameIdentity(
            await currentDirectoryIdentity(),
            file.parentIdentities[parentIndex]!,
          )
        ) {
          blocked = `identité du parent de destination incertaine (« ${currentPath} »)`;
          canAscend = false;
          throw new InstallError(blocked);
        }
      }
      const currentPath = await realpath('.');
      const expectedParentIdentity =
        file.parentIdentities.at(-1) ?? anchorIdentity;
      if (
        !isWithin(projectRoot, currentPath) ||
        !sameIdentity(await currentDirectoryIdentity(), expectedParentIdentity)
      ) {
        blocked = `identité du répertoire de destination incertaine (« ${currentPath} »)`;
        canAscend = false;
        throw new InstallError(blocked);
      }
      const current = await lstat(file.basename);
      if (
        current.isFile() &&
        current.dev === file.device &&
        current.ino === file.inode
      ) {
        await unlink(file.basename);
        removed += 1;
      } else {
        residual += 1;
        blocked = `le fichier créé a disparu ou son identité a changé (« ${file.basename} »)`;
      }
    } catch (error) {
      if (blocked === undefined) {
        blocked = error instanceof Error ? error.message : String(error);
      }
      residual += 1;
      if (!canAscend) {
        residual += files.length - index - 1;
        break;
      }
    } finally {
      if (canAscend) {
        for (let index = 0; index < depth; index += 1) process.chdir('..');
      }
    }
  }
  return { removed, residual, blocked };
}

async function removeEmptyCreatedDirectories(
  projectRoot: string,
  projectIdentity: FileIdentity,
  directories: CreatedDirectory[],
): Promise<string | undefined> {
  for (const directory of [...directories].reverse()) {
    process.chdir('..');
    const parentPath = await realpath('.').catch(() => '');
    if (
      !isWithin(projectRoot, parentPath) ||
      !sameIdentity(
        await currentDirectoryIdentity().catch(() => ({
          device: -1,
          inode: -1,
        })),
        directory.parentIdentity,
      )
    ) {
      return `répertoire parent de « ${directory.name} » déplacé ou d’identité incertaine`;
    }
    if (!directory.created) continue;

    let found = false;
    for (const entry of await readdir('.')) {
      const details = await lstat(entry).catch(() => undefined);
      if (
        !details ||
        details.isSymbolicLink() ||
        !details.isDirectory() ||
        !sameIdentity(identityFromStats(details), directory.identity)
      ) {
        continue;
      }
      found = true;
      try {
        await rmdir(entry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
      }
      break;
    }
    if (!found) {
      return `répertoire créé « ${directory.name} » renommé ou d’identité incertaine`;
    }
  }
  if (!sameIdentity(await currentDirectoryIdentity(), projectIdentity)) {
    return 'racine projet d’identité incertaine pendant le nettoyage des répertoires';
  }
  return undefined;
}

async function writeLockAtomicallyFromSkillRoot(
  projectRoot: string,
  idRoot: string,
  lock: LockFile,
): Promise<void> {
  const projectRelative = path.join('..', '..', '..');
  const lockPath = path.join(projectRelative, lockName);
  const temporaryPath = path.join(
    projectRelative,
    `.${lockName}.${randomUUID()}.tmp`,
  );
  let temporaryIdentity: FileIdentity | undefined;
  let operationError: unknown;
  let temporaryCleanupError: Error | undefined;
  await assertCurrentDirectory(idRoot);
  if ((await realpath(projectRelative)) !== projectRoot) {
    throw new InstallError(
      'La racine projet ancrée a changé ; verrou non écrit.',
    );
  }
  try {
    const handle = await open(temporaryPath, 'wx', 0o666);
    try {
      const details = await handle.stat();
      temporaryIdentity = identityFromStats(details);
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const staged = await lstat(temporaryPath);
    if (
      !temporaryIdentity ||
      !staged.isFile() ||
      !sameIdentity(identityFromStats(staged), temporaryIdentity)
    ) {
      throw new InstallError(
        'Le staging du verrou a changé d’identité ; il reste intact pour inspection.',
      );
    }
    await rename(temporaryPath, lockPath);
  } catch (error) {
    operationError = error;
  } finally {
    try {
      const staged = await lstat(temporaryPath).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        },
      );
      if (staged) {
        if (
          temporaryIdentity &&
          staged.isFile() &&
          sameIdentity(identityFromStats(staged), temporaryIdentity)
        ) {
          await unlink(temporaryPath);
        } else {
          temporaryCleanupError = new InstallError(
            'Un staging de verrou d’identité incertaine reste présent ; il n’a pas été supprimé.',
          );
        }
      }
    } catch (error) {
      temporaryCleanupError =
        error instanceof Error ? error : new Error(String(error));
    }
  }
  if (temporaryCleanupError) {
    const originalMessage =
      operationError instanceof Error
        ? operationError.message
        : operationError === undefined
          ? ''
          : String(operationError);
    throw new InstallError(
      `${originalMessage}${originalMessage ? ' ' : ''}${temporaryCleanupError.message}`,
    );
  }
  if (operationError !== undefined) throw operationError;
}

async function commitInstall(
  projectRoot: string,
  id: string,
  files: PlannedFile[],
  lock: LockFile,
  options: InstallOptions,
): Promise<void> {
  await withProcessCwdLock(async () => {
    const originalCwd = process.cwd();
    const idRoot = path.join(projectRoot, '.agents/skills', id);
    const createdFiles: CreatedFile[] = [];
    const createdDirectories: CreatedDirectory[] = [];
    let enteredIdRoot = false;
    let anchorIdentity: FileIdentity | undefined;
    let projectIdentity: FileIdentity | undefined;
    try {
      process.chdir(projectRoot);
      await assertCurrentDirectory(projectRoot);
      projectIdentity = await currentDirectoryIdentity();
      createdDirectories.push(
        await enterVerifiedDirectory(
          '.agents',
          path.join(projectRoot, '.agents'),
        ),
      );
      createdDirectories.push(
        await enterVerifiedDirectory(
          'skills',
          path.join(projectRoot, '.agents/skills'),
        ),
      );
      createdDirectories.push(await enterVerifiedDirectory(id, idRoot));
      anchorIdentity = await currentDirectoryIdentity();
      enteredIdRoot = true;

      for (const file of files) {
        const prefix = `${targetDirectory}/${id}/`;
        const relativePath = file.path.slice(prefix.length);
        assertSafeRelativePath(relativePath, 'Destination relative au skill');
        await writeFileFromAnchoredDirectory(
          file,
          relativePath.split('/'),
          idRoot,
          options.onBeforeFileCommit,
          options.onAfterCwdCheckBeforeWrite,
          createdFiles,
        );
      }

      await assertCurrentDirectory(idRoot);
      await writeLockAtomicallyFromSkillRoot(projectRoot, idRoot, lock);
    } catch (error) {
      let rollbackNote = '';
      if (enteredIdRoot && anchorIdentity && projectIdentity) {
        const result = await rollbackFromAnchoredDirectory(
          projectRoot,
          anchorIdentity,
          createdFiles,
        ).catch(() => ({
          removed: 0,
          residual: createdFiles.length,
          blocked: 'erreur pendant le rollback',
        }));
        let directoryCleanupWarning: string | undefined;
        if (
          result.residual === 0 &&
          isWithin(projectRoot, await realpath('.').catch(() => '')) &&
          sameIdentity(await currentDirectoryIdentity(), anchorIdentity)
        ) {
          directoryCleanupWarning = await removeEmptyCreatedDirectories(
            projectRoot,
            projectIdentity,
            createdDirectories,
          ).catch((cleanupError: unknown) =>
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
          );
        }
        if (result.residual > 0) {
          rollbackNote = ` Rollback incomplet : ${result.residual} fichier(s) transactionnel(s) peuvent rester ; ${result.blocked ?? 'identité de destination incertaine'}. Vérifiez le répertoire déplacé avant nettoyage manuel.`;
        } else if (directoryCleanupWarning) {
          rollbackNote = ` Nettoyage des répertoires incomplet : ${directoryCleanupWarning}. Aucun nettoyage plus large n’a été tenté.`;
        }
      }
      throw new InstallError(
        `Échec de l’installation.${rollbackNote} ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      process.chdir(originalCwd);
    }
  });
}

export type InstallOptions = {
  project?: string;
  catalogRoot?: string;
  interactive?: boolean;
  confirm?: () => Promise<boolean>;
  onProjectLockWait?: () => void;
  onBeforeFileCommit?: (destination: string) => Promise<void>;
  onAfterCwdCheckBeforeWrite?: (destination: string) => Promise<void>;
};

export async function runInstallCommand(
  args: string[],
  options: InstallOptions = {},
): Promise<void> {
  const parsed = parseInstallArgs(args);
  parseSpecifier(parsed.specifier);
  const project = options.project ?? parsed.project;
  const projectRoot = await ensureProjectRoot(path.resolve(project));
  const root = options.catalogRoot ?? sourceRoot;
  const releaseProjectLock = await acquireProjectLock(
    projectRoot,
    options.onProjectLockWait,
  );
  try {
    await runInstallWithProjectLock(parsed, projectRoot, root, options);
  } finally {
    await releaseProjectLock();
  }
}

async function runInstallWithProjectLock(
  parsed: ReturnType<typeof parseInstallArgs>,
  projectRoot: string,
  root: string,
  options: InstallOptions,
): Promise<void> {
  const { id, version: requestedVersion } = parseSpecifier(parsed.specifier);
  const artifacts = await loadCatalog(root);
  const artifact = artifacts.find((candidate) => candidate.id === id) as
    Artifact | undefined;
  if (!artifact) throw new InstallError(`Artefact inconnu « ${id} ».`);
  if (artifact.type !== 'skill') {
    throw new InstallError(
      `Type d’artefact non pris en charge : « ${artifact.type} ».`,
    );
  }
  const version = requestedVersion
    ? artifact.versions.find(
        (candidate) => candidate.version === requestedVersion,
      )
    : artifact.versions
        .filter((candidate) => !candidate.version.includes('-'))
        .sort((left, right) => rcompare(left.version, right.version))[0];
  if (!version) {
    throw new InstallError(
      requestedVersion
        ? `Version indisponible « ${id}@${requestedVersion} ».`
        : `Aucune version stable disponible pour « ${id} ».`,
    );
  }

  const manifestPath = path.join(root, 'catalog', id, 'artifact.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    provenance: { repository: string };
  };
  const plannedFiles: PlannedFile[] = [];
  for (const file of version.files) {
    assertSafeRelativePath(file.destination, 'Destination du catalogue');
    const expectedPrefix = `${targetDirectory}/${id}/`;
    if (!file.destination.startsWith(expectedPrefix)) {
      throw new InstallError(
        `Destination refusée pour ${id} : « ${file.destination} » doit rester sous « ${expectedPrefix} ».`,
      );
    }
    const { sourcePath, contents } = await readSourceFile(root, id, file.path);
    plannedFiles.push({
      path: file.destination,
      sourcePath,
      destinationPath: path.join(projectRoot, ...file.destination.split('/')),
      contents,
      sha256: createHash('sha256').update(contents).digest('hex'),
    });
  }

  const lock = await readLock(projectRoot);
  const existingEntry = lock.installs.find((entry) => entry.id === id);
  const nextFiles = plannedFiles
    .map(({ path: filePath, sha256 }) => ({ path: filePath, sha256 }))
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );

  if (existingEntry) {
    const previousFiles = [...existingEntry.files].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    if (
      existingEntry.version !== version.version ||
      existingEntry.source !== manifest.provenance.repository ||
      JSON.stringify(previousFiles) !== JSON.stringify(nextFiles)
    ) {
      throw new InstallError(
        `« ${id} » est déjà verrouillé différemment. Les mises à jour ne sont pas prises en charge par install ; aucun fichier modifié.`,
      );
    }
    for (const file of plannedFiles) {
      await inspectDestinationParents(projectRoot, file.path);
      const contents = await readFile(file.destinationPath).catch(
        () => undefined,
      );
      if (
        !contents ||
        createHash('sha256').update(contents).digest('hex') !== file.sha256
      ) {
        throw new InstallError(
          `Conflit : le fichier géré « ${file.path} » a été modifié ou supprimé. Aucun écrasement effectué.`,
        );
      }
    }
    console.log(
      `Déjà installé : ${id}@${version.version} (empreintes vérifiées).`,
    );
    return;
  }

  const otherLockedPaths = new Set(
    lock.installs.flatMap((entry) => entry.files.map((file) => file.path)),
  );
  for (const file of plannedFiles) {
    if (otherLockedPaths.has(file.path)) {
      throw new InstallError(
        `La destination « ${file.path} » appartient déjà à une autre entrée du verrou.`,
      );
    }
    if (await inspectDestinationParents(projectRoot, file.path)) {
      throw new InstallError(
        `Conflit : le fichier « ${file.path} » existe déjà et n’est pas géré par cette installation.`,
      );
    }
  }

  console.log(
    `Source : ${manifest.provenance.repository} (catalogue local de développement)`,
  );
  console.log(`Version : ${id}@${version.version}`);
  console.log(`Destination : ${projectRoot}`);
  console.log('Fichiers prévus :');
  for (const file of plannedFiles)
    console.log(`  ${file.sourcePath} → ${file.path}`);

  const interactive = options.interactive ?? stdin.isTTY;
  if (!parsed.confirmed && !interactive) {
    throw new InstallError(
      'Installation non interactive : confirmer explicitement avec --yes ou --non-interactive.',
    );
  }
  const confirmed =
    parsed.confirmed ||
    (options.confirm ? await options.confirm() : await confirmInstall(false));
  if (!confirmed) {
    console.log('Installation annulée.');
    return;
  }

  const nextLock: LockFile = {
    schemaVersion: 1,
    installs: [
      ...lock.installs,
      {
        id,
        version: version.version,
        target: targetDirectory,
        source: manifest.provenance.repository,
        files: nextFiles,
      },
    ].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
  };
  await commitInstall(projectRoot, id, plannedFiles, nextLock, options);
  console.log(
    `Installé : ${id}@${version.version} ; verrou écrit dans ${lockName}.`,
  );
}

export { InstallError };
