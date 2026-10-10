import { createHash } from 'node:crypto';
import { lstat, realpath, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import { format } from 'prettier';
import { rcompare, valid as validSemver } from 'semver';
import { resolvePackageRoot } from './package-root.ts';

type Compatibility = {
  environment: string;
  level: 'declared' | 'verified';
  evidence?: {
    testedVersion: string;
    method: string;
    reference: string;
  };
};

type ArtifactVersion = {
  version: string;
  publishedAt: string;
  files: { path: string; destination: string; sha256?: string }[];
  compatibilities: Compatibility[];
};

type Artifact = {
  id: string;
  type: string;
  versions: ArtifactVersion[];
};

export class CatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogValidationError';
  }
}

const projectRoot = resolvePackageRoot(import.meta.url);
const schemaPath = path.join(projectRoot, 'schemas', 'artifact.schema.json');
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
});
const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as object;
const validateArtifact = ajv.compile<Artifact>(schema);

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) =>
    character.codePointAt(0)!,
  );
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);

  for (let index = 0; index < sharedLength; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index]! - rightPoints[index]!;
    }
  }
  return leftPoints.length - rightPoints.length;
}

function isValidUtcDateTime(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
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
  return day >= 1 && day <= daysInMonth[month - 1]!;
}

function assertSafeRelativePath(value: string, label: string): void {
  const segments = value.split('/');
  const invalid =
    value.length === 0 ||
    value.includes('\\') ||
    value.includes(':') ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[a-zA-Z]:/.test(value) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        /[. ]$/.test(segment) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment),
    ) ||
    path.posix.normalize(value) !== value;

  if (invalid) {
    throw new CatalogValidationError(
      `${label}: chemin relatif dangereux « ${value} ».`,
    );
  }
}

function formatSchemaErrors(errors: ErrorObject[]): string {
  return errors
    .map(
      (error) =>
        `${error.instancePath || '/'} ${error.message ?? 'est invalide'}`,
    )
    .join('; ');
}

async function readArtifact(
  directory: string,
  catalogRoot: string,
): Promise<Artifact> {
  const manifestPath = path.join(directory, 'artifact.json');
  let manifestRealPath: string;
  try {
    manifestRealPath = await realpath(manifestPath);
    const manifestStat = await stat(manifestRealPath);
    if (!manifestStat.isFile() || !isWithin(catalogRoot, manifestRealPath)) {
      throw new CatalogValidationError(
        `${manifestPath}: manifeste absent ou hors du catalogue.`,
      );
    }
  } catch (error) {
    if (error instanceof CatalogValidationError) throw error;
    throw new CatalogValidationError(
      `${manifestPath}: manifeste introuvable ou illisible.`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(await readFile(manifestRealPath, 'utf8')) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CatalogValidationError(
      `${manifestPath}: JSON illisible (${detail}).`,
    );
  }

  if (!validateArtifact(data)) {
    throw new CatalogValidationError(
      `${manifestPath}: ${formatSchemaErrors(validateArtifact.errors ?? [])}`,
    );
  }

  const artifact = data as Artifact;
  const artifactDirectory = await realpath(directory);
  const seenVersions = new Set<string>();
  for (const version of artifact.versions) {
    if (!isValidUtcDateTime(version.publishedAt)) {
      throw new CatalogValidationError(
        `${manifestPath}: date de publication invalide « ${version.publishedAt} » ; utiliser une date UTC réelle au format RFC 3339.`,
      );
    }
    if (validSemver(version.version) !== version.version) {
      throw new CatalogValidationError(
        `${manifestPath}: version « ${version.version} » invalide ; utiliser une version SemVer stricte.`,
      );
    }
    if (seenVersions.has(version.version)) {
      throw new CatalogValidationError(
        `${manifestPath}: version dupliquée « ${version.version} ».`,
      );
    }
    seenVersions.add(version.version);

    const sourcePaths = new Set<string>();
    const destinations = new Set<string>();
    const environments = new Set<string>();
    for (const compatibility of version.compatibilities) {
      if (environments.has(compatibility.environment)) {
        throw new CatalogValidationError(
          `${manifestPath}: environnement dupliqué « ${compatibility.environment} » pour ${version.version}.`,
        );
      }
      environments.add(compatibility.environment);
    }

    for (const file of version.files) {
      assertSafeRelativePath(file.path, `${manifestPath} (${version.version})`);
      assertSafeRelativePath(
        file.destination,
        `${manifestPath} destination (${version.version})`,
      );
      if (sourcePaths.has(file.path)) {
        throw new CatalogValidationError(
          `${manifestPath}: fichier source dupliqué « ${file.path} ».`,
        );
      }
      if (destinations.has(file.destination)) {
        throw new CatalogValidationError(
          `${manifestPath}: destination dupliquée « ${file.destination} ».`,
        );
      }
      sourcePaths.add(file.path);
      destinations.add(file.destination);

      const filePath = path.resolve(artifactDirectory, ...file.path.split('/'));
      let resolvedFilePath: string;
      try {
        resolvedFilePath = await realpath(filePath);
        const fileStat = await stat(resolvedFilePath);
        if (
          !fileStat.isFile() ||
          !isWithin(artifactDirectory, resolvedFilePath)
        ) {
          throw new CatalogValidationError(
            `${manifestPath}: le fichier « ${file.path} » est absent ou sort du paquet ${artifact.id}.`,
          );
        }
      } catch (error) {
        if (error instanceof CatalogValidationError) throw error;
        throw new CatalogValidationError(
          `${manifestPath}: fichier absent ou sortant du paquet « ${file.path} » (${artifact.id}@${version.version}).`,
        );
      }
    }
  }

  artifact.versions.sort((left, right) => {
    const order = rcompare(left.version, right.version);
    return order || compareCodePoints(left.version, right.version);
  });
  for (const version of artifact.versions) {
    version.files.sort((left, right) =>
      compareCodePoints(left.path, right.path),
    );
    version.compatibilities.sort((left, right) =>
      compareCodePoints(left.environment, right.environment),
    );
  }
  return artifact;
}

export async function loadCatalog(root = projectRoot): Promise<Artifact[]> {
  const resolvedRoot = await realpath(root);
  const catalogPath = path.join(resolvedRoot, 'catalog');
  const catalogPathStat = await lstat(catalogPath);
  if (catalogPathStat.isSymbolicLink()) {
    throw new CatalogValidationError(
      `La racine du catalogue « ${catalogPath} » ne peut pas être un lien symbolique.`,
    );
  }
  if (!catalogPathStat.isDirectory()) {
    throw new CatalogValidationError(
      `La racine du catalogue « ${catalogPath} » doit être un dossier réel.`,
    );
  }

  const catalogRoot = await realpath(catalogPath);
  if (!isWithin(resolvedRoot, catalogRoot)) {
    throw new CatalogValidationError(
      `La racine du catalogue « ${catalogPath} » sort du dépôt.`,
    );
  }
  const entries = await readdir(catalogRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new CatalogValidationError(
        `Entrée catalogue symbolique interdite « ${entry.name} » ; aucune entrée ne peut être ignorée silencieusement.`,
      );
    }
  }
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareCodePoints);
  const ids = new Set<string>();
  const artifacts: Artifact[] = [];

  for (const directoryName of directories) {
    const directory = path.join(catalogRoot, directoryName);
    const artifact = await readArtifact(directory, catalogRoot);
    if (ids.has(artifact.id)) {
      throw new CatalogValidationError(
        `Identifiant d'artefact dupliqué « ${artifact.id} ».`,
      );
    }
    if (artifact.id !== directoryName) {
      throw new CatalogValidationError(
        `${path.join(directory, 'artifact.json')}: l'identifiant « ${artifact.id} » doit correspondre au dossier « ${directoryName} ».`,
      );
    }
    ids.add(artifact.id);
    artifacts.push(artifact);
  }

  if (artifacts.length === 0) {
    throw new CatalogValidationError(
      'Le catalogue ne contient aucun artefact.',
    );
  }
  return artifacts.sort((left, right) => compareCodePoints(left.id, right.id));
}

export async function buildCatalogIndex(root = projectRoot): Promise<string> {
  const artifacts = await loadCatalog(root);
  for (const artifact of artifacts) {
    for (const version of artifact.versions) {
      for (const file of version.files) {
        const contents = await readFile(
          path.join(root, 'catalog', artifact.id, ...file.path.split('/')),
        );
        file.sha256 = createHash('sha256').update(contents).digest('hex');
      }
    }
  }
  return format(`${JSON.stringify({ schemaVersion: 2, artifacts })}\n`, {
    parser: 'json',
  });
}

export async function validateCatalog(root = projectRoot): Promise<void> {
  await loadCatalog(root);
}

export { projectRoot };
