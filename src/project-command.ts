import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
  link,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import { gt, rcompare } from 'semver';
import { loadCatalog, projectRoot as catalogProjectRoot } from './catalog.ts';
import { resolveCatalogIndex } from './registry-index.ts';
import {
  acquireProjectLock,
  ensureProjectRoot,
  InstallError,
  readLock,
  withProcessCwdLock,
  type LockEntry,
  type LockFile,
} from './install-command.ts';

type ArtifactFile = { path: string; destination: string };
type ArtifactVersion = { version: string; files: ArtifactFile[] };
type Artifact = {
  id: string;
  type: string;
  provenance: { repository: string };
  versions: ArtifactVersion[];
};
type FileSnapshot = {
  contents: Buffer;
  sha256: string;
  device: number;
  inode: number;
};
type PlannedChange = {
  path: string;
  kind: 'added' | 'modified' | 'unchanged' | 'orphan';
  source?: string;
  beforeSha256?: string;
  afterSha256?: string;
  diff?: string;
  localConflict?: boolean;
  unmanagedConflict?: boolean;
  currentContents?: Buffer;
  nextContents?: Buffer;
  currentIdentity?: { device: number; inode: number };
};
type ArtifactPlan = {
  id: string;
  fromVersion: string;
  toVersion: string;
  provenance: string;
  sourceLocal: string;
  target: string;
  changes: PlannedChange[];
};
type FileMutation = {
  path: string;
  oldContents?: Buffer;
  newIdentity?: { device: number; inode: number };
  parentSegments: string[];
  parentIdentities: { device: number; inode: number }[];
};
type DirectoryIdentity = {
  relativePath: string;
  device: number;
  inode: number;
  parentSegments: string[];
  parentIdentities: { device: number; inode: number }[];
};
type LockSnapshot = {
  contents: Buffer;
  device: number;
  inode: number;
};

const lockName = 'lufa.lock.json';
const targetDirectory = '.agents/skills';
const sourceRoot = catalogProjectRoot;
const backupRoot = '.lufa/backups';

export type ProjectCommandOptions = {
  project?: string;
  catalogRoot?: string;
  interactive?: boolean;
  confirm?: () => Promise<boolean>;
  onProjectLockWait?: () => void;
  onBeforeFileCommit?: (destination: string) => Promise<void>;
  onBeforeLockCommit?: () => Promise<void>;
};

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function digest(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function validateProjectPath(value: string): void {
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
        !segment ||
        segment === '.' ||
        segment === '..' ||
        /[. ]$/.test(segment) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment),
    ) ||
    path.posix.normalize(value) !== value
  ) {
    throw new InstallError(
      `Chemin géré dangereux dans ${lockName} : « ${value} ».`,
    );
  }
}

function parseReadArgs(
  args: string[],
  command: string,
): {
  project: string;
  json: boolean;
} {
  let project = process.cwd();
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--json') json = true;
    else if (argument === '--project') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new InstallError('L’option --project attend un chemin.');
      }
      project = path.resolve(value);
      index += 1;
    } else {
      throw new InstallError(
        `Option ou argument inconnu « ${argument} » pour ${command}.`,
      );
    }
  }
  return { project, json };
}

function parseUpdateArgs(args: string[]): {
  id?: string;
  project: string;
  json: boolean;
  force: boolean;
  confirmed: boolean;
} {
  const ids: string[] = [];
  let project = process.cwd();
  let json = false;
  let force = false;
  let confirmed = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--json') json = true;
    else if (argument === '--force') force = true;
    else if (argument === '--yes' || argument === '--non-interactive') {
      confirmed = true;
    } else if (argument === '--project') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new InstallError('L’option --project attend un chemin.');
      }
      project = path.resolve(value);
      index += 1;
    } else if (argument.startsWith('-')) {
      throw new InstallError(`Option inconnue « ${argument} » pour update.`);
    } else {
      ids.push(argument);
    }
  }
  if (
    ids.length > 1 ||
    (ids.length === 1 && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ids[0]!))
  ) {
    throw new InstallError(
      'Usage : lufa update [identifiant] [--project <chemin>] [--force] [--yes] [--json]',
    );
  }
  return { id: ids[0], project, json, force, confirmed };
}

async function readInstalled(projectRoot: string): Promise<LockFile> {
  return readLock(projectRoot);
}

export async function runInstalledCommand(
  args: string[],
  options: ProjectCommandOptions = {},
): Promise<void> {
  const parsed = parseReadArgs(args, 'installed');
  const project = await ensureProjectRoot(options.project ?? parsed.project);
  const lock = await readInstalled(project);
  const entries = lock.installs.map((entry) => ({
    id: entry.id,
    version: entry.version,
    target: entry.target,
    files: entry.files.map(({ path: filePath }) => filePath),
  }));
  if (parsed.json) console.log(JSON.stringify(entries, null, 2));
  else if (entries.length === 0) console.log('Aucun artefact installé.');
  else {
    for (const entry of entries) {
      console.log(`${entry.id}@${entry.version}\t${entry.target}`);
      for (const file of entry.files) console.log(`  ${file}`);
    }
  }
}

function newestStable(artifact: Artifact): ArtifactVersion | undefined {
  return artifact.versions
    .filter((version) => !version.version.includes('-'))
    .sort((left, right) => rcompare(left.version, right.version))[0];
}

export async function runOutdatedCommand(
  args: string[],
  options: ProjectCommandOptions = {},
): Promise<void> {
  const parsed = parseReadArgs(args, 'outdated');
  const project = await ensureProjectRoot(options.project ?? parsed.project);
  const lock = await readInstalled(project);
  const { index } = await resolveCatalogIndex();
  const artifacts = index.artifacts as unknown as Artifact[];
  const catalog = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const result = lock.installs.map((entry) => {
    const artifact = catalog.get(entry.id);
    const latest = artifact && newestStable(artifact);
    const availability = !latest
      ? 'unavailable'
      : gt(latest.version, entry.version)
        ? 'outdated'
        : 'up-to-date';
    return {
      id: entry.id,
      lockedVersion: entry.version,
      latestStable: latest?.version ?? null,
      target: entry.target,
      availability,
    };
  });
  if (parsed.json) console.log(JSON.stringify(result, null, 2));
  else if (result.length === 0) console.log('Aucun artefact installé.');
  else {
    for (const entry of result) {
      const latest = entry.latestStable
        ? ` ; stable disponible ${entry.latestStable}`
        : '';
      console.log(
        `${entry.id}@${entry.lockedVersion} : ${entry.availability}${latest}`,
      );
    }
  }
}

async function readSnapshot(
  projectRoot: string,
  relativePath: string,
): Promise<FileSnapshot | undefined> {
  validateProjectPath(relativePath);
  const segments = relativePath.split('/');
  let current = projectRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new InstallError(
        `Destination dangereuse ou non ordinaire : « ${relativePath} ».`,
      );
    }
  }
  const absolute = path.join(projectRoot, ...segments);
  let details;
  try {
    details = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new InstallError(
      `La destination « ${relativePath} » doit être un fichier ordinaire.`,
    );
  }
  const contents = await readFile(absolute);
  return {
    contents,
    sha256: digest(contents),
    device: details.dev,
    inode: details.ino,
  };
}

function unifiedDiff(
  oldText: string,
  newText: string,
  oldLabel: string,
  newLabel: string,
): string {
  const oldLines = oldText.split(/(?<=\n)/);
  const newLines = newText.split(/(?<=\n)/);
  const cells = (oldLines.length + 1) * (newLines.length + 1);
  let lines: string[];
  if (cells > 1_000_000) {
    lines = [
      ...oldLines.map((line) => `-${line.replace(/\n$/, '')}`),
      ...newLines.map((line) => `+${line.replace(/\n$/, '')}`),
    ];
  } else {
    const width = newLines.length + 1;
    const table = new Uint32Array(cells);
    for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
      for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
        const cell = oldIndex * width + newIndex;
        table[cell] =
          oldLines[oldIndex] === newLines[newIndex]
            ? table[(oldIndex + 1) * width + newIndex + 1]! + 1
            : Math.max(
                table[(oldIndex + 1) * width + newIndex]!,
                table[cell + 1]!,
              );
      }
    }
    lines = [];
    let oldIndex = 0;
    let newIndex = 0;
    while (oldIndex < oldLines.length || newIndex < newLines.length) {
      if (
        oldIndex < oldLines.length &&
        newIndex < newLines.length &&
        oldLines[oldIndex] === newLines[newIndex]
      ) {
        lines.push(` ${oldLines[oldIndex]!.replace(/\n$/, '')}`);
        oldIndex += 1;
        newIndex += 1;
      } else if (
        newIndex < newLines.length &&
        (oldIndex === oldLines.length ||
          table[oldIndex * width + newIndex + 1]! >=
            table[(oldIndex + 1) * width + newIndex]!)
      ) {
        lines.push(`+${newLines[newIndex]!.replace(/\n$/, '')}`);
        newIndex += 1;
      } else {
        lines.push(`-${oldLines[oldIndex]!.replace(/\n$/, '')}`);
        oldIndex += 1;
      }
    }
  }
  return [`--- ${oldLabel}`, `+++ ${newLabel}`, ...lines].join('\n');
}

async function artifactManifest(
  root: string,
  id: string,
): Promise<{ provenance: { repository: string } }> {
  const manifest = JSON.parse(
    await readFile(path.join(root, 'catalog', id, 'artifact.json'), 'utf8'),
  ) as { provenance: { repository: string } };
  return manifest;
}

async function makeArtifactPlan(
  projectRoot: string,
  entry: LockEntry,
  artifact: Artifact | undefined,
  root: string,
): Promise<ArtifactPlan | undefined> {
  const version = artifact && newestStable(artifact);
  if (!artifact || !version || !gt(version.version, entry.version))
    return undefined;
  if (artifact.type !== 'skill')
    throw new InstallError(
      `Type non pris en charge pour update : « ${artifact.type} ».`,
    );
  const manifest = await artifactManifest(root, entry.id);
  const oldFiles = new Map(entry.files.map((file) => [file.path, file]));
  const newFiles = new Map<
    string,
    { contents: Buffer; source: string; sha256: string }
  >();
  for (const file of version.files) {
    validateProjectPath(file.destination);
    const prefix = `${targetDirectory}/${entry.id}/`;
    if (!file.destination.startsWith(prefix)) {
      throw new InstallError(
        `Destination refusée pour ${entry.id} : « ${file.destination} ».`,
      );
    }
    const source = path.join(
      root,
      'catalog',
      entry.id,
      ...file.path.split('/'),
    );
    const contents = await readFile(source);
    newFiles.set(file.destination, {
      contents,
      source,
      sha256: digest(contents),
    });
  }

  const changes: PlannedChange[] = [];
  for (const [filePath, next] of newFiles) {
    const previousLock = oldFiles.get(filePath);
    const snapshot = await readSnapshot(projectRoot, filePath);
    if (!previousLock) {
      if (snapshot) {
        changes.push({
          path: filePath,
          kind: 'added',
          source: next.source,
          beforeSha256: snapshot.sha256,
          afterSha256: next.sha256,
          diff: unifiedDiff(
            snapshot.contents.toString('utf8'),
            next.contents.toString('utf8'),
            `local ${filePath}`,
            `catalogue ${version.version}`,
          ),
          localConflict: true,
          unmanagedConflict: true,
          currentContents: snapshot.contents,
          currentIdentity: { device: snapshot.device, inode: snapshot.inode },
          nextContents: next.contents,
        });
      } else {
        changes.push({
          path: filePath,
          kind: 'added',
          source: next.source,
          afterSha256: next.sha256,
          diff: unifiedDiff(
            '',
            next.contents.toString('utf8'),
            '/dev/null',
            `catalogue ${version.version}`,
          ),
          nextContents: next.contents,
        });
      }
      continue;
    }
    const localConflict = !snapshot || snapshot.sha256 !== previousLock.sha256;
    const kind = previousLock.sha256 === next.sha256 ? 'unchanged' : 'modified';
    changes.push({
      path: filePath,
      kind,
      source: next.source,
      beforeSha256: snapshot?.sha256 ?? previousLock.sha256,
      afterSha256: next.sha256,
      diff:
        snapshot && snapshot.sha256 !== next.sha256
          ? unifiedDiff(
              snapshot.contents.toString('utf8'),
              next.contents.toString('utf8'),
              `local ${filePath}`,
              `catalogue ${version.version}`,
            )
          : undefined,
      localConflict,
      currentContents: snapshot?.contents,
      currentIdentity: snapshot
        ? { device: snapshot.device, inode: snapshot.inode }
        : undefined,
      nextContents: next.contents,
    });
  }
  for (const previous of entry.files) {
    if (newFiles.has(previous.path)) continue;
    const snapshot = await readSnapshot(projectRoot, previous.path);
    changes.push({
      path: previous.path,
      kind: 'orphan',
      beforeSha256: snapshot?.sha256 ?? previous.sha256,
      localConflict: !!snapshot && snapshot.sha256 !== previous.sha256,
    });
  }
  changes.sort((left, right) => comparePath(left.path, right.path));
  return {
    id: entry.id,
    fromVersion: entry.version,
    toVersion: version.version,
    provenance: manifest.provenance.repository,
    sourceLocal: path.join(root, 'catalog', entry.id),
    target: entry.target,
    changes,
  };
}

function serializePlan(plan: ArtifactPlan) {
  return {
    id: plan.id,
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    provenance: plan.provenance,
    sourceLocal: plan.sourceLocal,
    target: plan.target,
    changes: plan.changes.map((change) => {
      const serialized = { ...change };
      delete serialized.currentContents;
      delete serialized.nextContents;
      delete serialized.currentIdentity;
      return serialized;
    }),
  };
}

async function confirmUpdate(
  confirmed: boolean,
  interactive: boolean,
): Promise<boolean> {
  if (confirmed) return true;
  if (!interactive || !stdin.isTTY) {
    throw new InstallError(
      'Mise à jour non interactive : confirmer explicitement avec --yes ou --non-interactive.',
    );
  }
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return /^(o|oui|y|yes)$/i.test(
      (await readline.question('Appliquer cette mise à jour ? [o/N] ')).trim(),
    );
  } finally {
    readline.close();
  }
}

async function ensureDirectoryChain(
  projectRoot: string,
  relativeDirectory: string,
  created: DirectoryIdentity[],
): Promise<void> {
  const segments = relativeDirectory ? relativeDirectory.split('/') : [];
  let current = projectRoot;
  const parentSegments: string[] = [];
  const parentIdentities: { device: number; inode: number }[] = [];
  for (const segment of segments) {
    current = path.join(current, segment);
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(current);
      details = await lstat(current);
      if (details.isSymbolicLink() || !details.isDirectory())
        throw new InstallError(
          `Répertoire créé d’identité incertaine : « ${current} ».`,
        );
      created.push({
        relativePath: [...parentSegments, segment].join('/'),
        device: details.dev,
        inode: details.ino,
        parentSegments: [...parentSegments],
        parentIdentities: [...parentIdentities],
      });
    }
    if (details.isSymbolicLink() || !details.isDirectory())
      throw new InstallError(
        `Répertoire de destination dangereux : « ${current} ».`,
      );
    parentSegments.push(segment);
    parentIdentities.push({ device: details.dev, inode: details.ino });
  }
}

async function assertRootIdentity(
  projectRoot: string,
  device: number,
  inode: number,
): Promise<void> {
  const [canonical, details] = await Promise.all([
    readlinkSafeRealpath(projectRoot),
    lstat(projectRoot),
  ]);
  if (
    canonical !== projectRoot ||
    !details.isDirectory() ||
    details.dev !== device ||
    details.ino !== inode
  ) {
    throw new InstallError(
      'La racine projet a changé d’identité ; opération annulée.',
    );
  }
}

async function readlinkSafeRealpath(value: string): Promise<string> {
  return realpath(value);
}

async function inspectParentIdentity(
  projectRoot: string,
  relativePath: string,
): Promise<{ device: number; inode: number }> {
  const segments = relativePath.split('/').slice(0, -1);
  let current = projectRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const details = await lstat(current);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new InstallError(
        `Parent de destination dangereux pour « ${relativePath} ».`,
      );
    }
  }
  const canonicalRoot = await realpath(projectRoot);
  const canonicalParent = await realpath(current);
  const relative = path.relative(canonicalRoot, canonicalParent);
  if (
    canonicalRoot !== projectRoot ||
    (relative !== '' &&
      (relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)))
  ) {
    throw new InstallError(
      `Parent de destination sorti du projet pour « ${relativePath} ».`,
    );
  }
  const parent = await lstat(current);
  return { device: parent.dev, inode: parent.ino };
}

async function captureParentChain(
  projectRoot: string,
  rootDevice: number,
  rootInode: number,
  relativePath: string,
): Promise<{
  parentSegments: string[];
  parentIdentities: { device: number; inode: number }[];
}> {
  await assertRootIdentity(projectRoot, rootDevice, rootInode);
  const parentSegments = relativePath.split('/').slice(0, -1);
  const parentIdentities: { device: number; inode: number }[] = [];
  let current = projectRoot;
  for (const segment of parentSegments) {
    current = path.join(current, segment);
    const details = await lstat(current);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new InstallError(
        `Parent de destination dangereux pour « ${relativePath} ».`,
      );
    }
    const canonical = await realpath(current);
    if (!isWithin(projectRoot, canonical)) {
      throw new InstallError(
        `Parent de destination sorti du projet pour « ${relativePath} ».`,
      );
    }
    parentIdentities.push({ device: details.dev, inode: details.ino });
  }
  return { parentSegments, parentIdentities };
}

async function atomicWrite(
  projectRoot: string,
  relativePath: string,
  contents: Buffer,
  expected?: { device: number; inode: number },
): Promise<{ device: number; inode: number }> {
  const parentIdentity = await inspectParentIdentity(projectRoot, relativePath);
  const segments = relativePath.split('/');
  const parent = path.join(projectRoot, ...segments.slice(0, -1));
  const basename = segments.at(-1)!;
  const temporary = path.join(parent, `.lufa-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  let tempIdentity: { device: number; inode: number };
  let linkedDestination = false;
  try {
    const info = await handle.stat();
    tempIdentity = { device: info.dev, inode: info.ino };
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const staged = await lstat(temporary);
    if (
      !staged.isFile() ||
      staged.dev !== tempIdentity.device ||
      staged.ino !== tempIdentity.inode
    ) {
      throw new InstallError(
        `Le staging de « ${relativePath} » a changé d’identité ; il est préservé.`,
      );
    }
    const currentParent = await inspectParentIdentity(
      projectRoot,
      relativePath,
    );
    if (
      currentParent.device !== parentIdentity.device ||
      currentParent.inode !== parentIdentity.inode
    ) {
      throw new InstallError(
        `Le parent de « ${relativePath} » a changé d’identité ; staging préservé pour inspection.`,
      );
    }
    if (expected) {
      const current = await lstat(path.join(parent, basename));
      if (
        !current.isFile() ||
        current.dev !== expected.device ||
        current.ino !== expected.inode
      ) {
        throw new InstallError(
          `La destination « ${relativePath} » a changé d’identité ; écriture annulée.`,
        );
      }
      await rename(temporary, path.join(parent, basename));
      return tempIdentity;
    } else {
      await link(temporary, path.join(parent, basename));
      linkedDestination = true;
      await unlink(temporary);
      return tempIdentity;
    }
  } catch (error) {
    let cleanupWarning = '';
    if (linkedDestination) {
      try {
        const currentParent = await inspectParentIdentity(
          projectRoot,
          relativePath,
        );
        if (
          currentParent.device !== parentIdentity.device ||
          currentParent.inode !== parentIdentity.inode
        ) {
          cleanupWarning = ` La destination de staging pour « ${relativePath} » reste intacte car son parent a changé d’identité.`;
        } else {
          const destination = await lstat(path.join(parent, basename));
          if (
            destination.isFile() &&
            destination.dev === tempIdentity.device &&
            destination.ino === tempIdentity.inode
          ) {
            await unlink(path.join(parent, basename));
          } else {
            cleanupWarning = ` La destination « ${relativePath} » a changé d’identité et reste intacte.`;
          }
        }
      } catch {
        cleanupWarning = ` La destination « ${relativePath} » n’a pas pu être vérifiée après échec du staging et reste intacte.`;
      }
    }
    const current = await lstat(temporary).catch(
      (failure: NodeJS.ErrnoException) =>
        failure.code === 'ENOENT' ? undefined : Promise.reject(failure),
    );
    if (
      current &&
      current.isFile() &&
      current.dev === tempIdentity.device &&
      current.ino === tempIdentity.inode
    )
      await unlink(temporary);
    else if (current)
      throw new InstallError(
        `Le staging « ${temporary} » a une identité incertaine ; il est préservé.`,
      );
    throw new InstallError(
      `${error instanceof Error ? error.message : String(error)}${cleanupWarning}`,
    );
  }
}

async function writeBackup(
  projectRoot: string,
  transaction: string,
  relativePath: string,
  contents: Buffer,
  createdDirectories: DirectoryIdentity[],
): Promise<string> {
  const backupRelative = `${backupRoot}/${transaction}/${relativePath}`;
  const parent = path.posix.dirname(backupRelative);
  await ensureDirectoryChain(projectRoot, parent, createdDirectories);
  await atomicWrite(projectRoot, backupRelative, contents);
  return backupRelative;
}

async function enterAnchoredDirectory(
  projectRoot: string,
  rootDevice: number,
  rootInode: number,
  segments: string[],
  expectedIdentities: { device: number; inode: number }[],
): Promise<string> {
  if (segments.length !== expectedIdentities.length) {
    throw new InstallError(
      'Chaîne de parents incomplète ; nettoyage sûr impossible.',
    );
  }
  process.chdir(projectRoot);
  let expectedPath = projectRoot;
  const root = await lstat('.');
  if (
    (await realpath('.')) !== projectRoot ||
    !root.isDirectory() ||
    root.dev !== rootDevice ||
    root.ino !== rootInode
  ) {
    throw new InstallError(
      'La racine projet ancrée a changé d’identité ou d’emplacement ; résidu préservé.',
    );
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const details = await lstat(segment);
    const expected = expectedIdentities[index]!;
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      details.dev !== expected.device ||
      details.ino !== expected.inode
    ) {
      throw new InstallError(
        `Parent « ${[...segments.slice(0, index), segment].join('/')} » d’identité incertaine ; résidu préservé.`,
      );
    }
    process.chdir(segment);
    expectedPath = path.join(expectedPath, segment);
    const current = await lstat('.');
    const canonical = await realpath('.');
    if (
      canonical !== expectedPath ||
      !isWithin(projectRoot, canonical) ||
      !current.isDirectory() ||
      current.dev !== expected.device ||
      current.ino !== expected.inode
    ) {
      throw new InstallError(
        `Parent « ${segments.slice(0, index + 1).join('/')} » déplacé ou hors projet ; résidu préservé.`,
      );
    }
  }
  return expectedPath;
}

async function assertAnchoredParent(
  expectedPath: string,
  expectedIdentity: { device: number; inode: number },
  label: string,
): Promise<void> {
  const current = await lstat('.');
  const canonical = await realpath('.');
  if (
    canonical !== expectedPath ||
    !current.isDirectory() ||
    current.dev !== expectedIdentity.device ||
    current.ino !== expectedIdentity.inode
  ) {
    throw new InstallError(
      `Parent de « ${label} » déplacé ou d’identité incertaine ; résidu préservé.`,
    );
  }
}

async function rollbackOneMutation(
  projectRoot: string,
  rootDevice: number,
  rootInode: number,
  mutation: FileMutation,
): Promise<void> {
  if (!mutation.newIdentity) {
    throw new InstallError(
      'Identité du fichier transactionnel inconnue ; résidu préservé.',
    );
  }
  const parentPath = await enterAnchoredDirectory(
    projectRoot,
    rootDevice,
    rootInode,
    mutation.parentSegments,
    mutation.parentIdentities,
  );
  const parentIdentity = mutation.parentIdentities.at(-1) ?? {
    device: rootDevice,
    inode: rootInode,
  };
  const basename = path.posix.basename(mutation.path);
  await assertAnchoredParent(parentPath, parentIdentity, mutation.path);
  const current = await lstat(basename);
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.dev !== mutation.newIdentity.device ||
    current.ino !== mutation.newIdentity.inode
  ) {
    throw new InstallError(
      `« ${mutation.path} » a changé d’identité ; résidu préservé.`,
    );
  }

  if (mutation.oldContents === undefined) {
    await assertAnchoredParent(parentPath, parentIdentity, mutation.path);
    const beforeDelete = await lstat(basename);
    if (
      !beforeDelete.isFile() ||
      beforeDelete.dev !== mutation.newIdentity.device ||
      beforeDelete.ino !== mutation.newIdentity.inode
    ) {
      throw new InstallError(
        `« ${mutation.path} » a changé avant suppression ; résidu préservé.`,
      );
    }
    await unlink(basename);
    return;
  }

  const temporary = `.lufa-rollback-${randomUUID()}.tmp`;
  let temporaryIdentity: { device: number; inode: number } | undefined;
  let committed = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      const details = await handle.stat();
      temporaryIdentity = { device: details.dev, inode: details.ino };
      await handle.writeFile(mutation.oldContents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertAnchoredParent(parentPath, parentIdentity, mutation.path);
    const staged = await lstat(temporary);
    const destination = await lstat(basename);
    if (
      !temporaryIdentity ||
      !staged.isFile() ||
      staged.dev !== temporaryIdentity.device ||
      staged.ino !== temporaryIdentity.inode ||
      !destination.isFile() ||
      destination.dev !== mutation.newIdentity.device ||
      destination.ino !== mutation.newIdentity.inode
    ) {
      throw new InstallError(
        `Identité de staging/destination incertaine pour « ${mutation.path} » ; résidu préservé.`,
      );
    }
    await assertAnchoredParent(parentPath, parentIdentity, mutation.path);
    await rename(temporary, basename);
    committed = true;
  } finally {
    if (!committed && temporaryIdentity) {
      try {
        await assertAnchoredParent(parentPath, parentIdentity, mutation.path);
        const staged = await lstat(temporary);
        if (
          staged.isFile() &&
          staged.dev === temporaryIdentity.device &&
          staged.ino === temporaryIdentity.inode
        ) {
          await unlink(temporary);
        }
      } catch {
        // Preserve a staging file whenever its anchored parent is uncertain.
      }
    }
  }
}

async function removeCreatedDirectory(
  projectRoot: string,
  rootDevice: number,
  rootInode: number,
  directory: DirectoryIdentity,
): Promise<void> {
  const parentPath = await enterAnchoredDirectory(
    projectRoot,
    rootDevice,
    rootInode,
    directory.parentSegments,
    directory.parentIdentities,
  );
  const parentIdentity = directory.parentIdentities.at(-1) ?? {
    device: rootDevice,
    inode: rootInode,
  };
  const basename = path.posix.basename(directory.relativePath);
  await assertAnchoredParent(
    parentPath,
    parentIdentity,
    directory.relativePath,
  );
  const current = await lstat(basename);
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== directory.device ||
    current.ino !== directory.inode
  ) {
    throw new InstallError(
      `Répertoire « ${directory.relativePath} » d’identité incertaine ; préservé.`,
    );
  }
  await assertAnchoredParent(
    parentPath,
    parentIdentity,
    directory.relativePath,
  );
  await rmdir(basename);
}

async function rollbackMutations(
  projectRoot: string,
  rootDevice: number,
  rootInode: number,
  mutations: FileMutation[],
  createdDirectories: DirectoryIdentity[],
): Promise<string[]> {
  const warnings: string[] = [];
  for (const mutation of [...mutations].reverse()) {
    const originalCwd = process.cwd();
    try {
      await rollbackOneMutation(projectRoot, rootDevice, rootInode, mutation);
    } catch (error) {
      warnings.push(
        `Rollback impossible pour « ${mutation.path} » : ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      try {
        process.chdir(originalCwd);
      } catch {
        warnings.push(
          `CWD d’origine « ${originalCwd} » impossible à restaurer ; vérifiez l’emplacement du résidu.`,
        );
      }
    }
  }
  for (const directory of [...createdDirectories].reverse()) {
    const originalCwd = process.cwd();
    try {
      await removeCreatedDirectory(
        projectRoot,
        rootDevice,
        rootInode,
        directory,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY') {
        warnings.push(
          `Répertoire « ${directory.relativePath} » préservé : ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      try {
        process.chdir(originalCwd);
      } catch {
        warnings.push(
          `CWD d’origine « ${originalCwd} » impossible à restaurer après nettoyage.`,
        );
      }
    }
  }
  return warnings;
}

async function applyPlans(
  projectRoot: string,
  lock: LockFile,
  originalLock: LockSnapshot,
  plans: ArtifactPlan[],
  force: boolean,
  options: ProjectCommandOptions,
): Promise<string[]> {
  const rootInfo = await lstat(projectRoot);
  const rootDevice = rootInfo.dev;
  const rootInode = rootInfo.ino;
  const createdDirectories: DirectoryIdentity[] = [];
  const mutations: FileMutation[] = [];
  const transaction = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  const backupPaths: string[] = [];
  try {
    const nextLock: LockFile = structuredClone(lock);
    for (const plan of plans) {
      const updated = nextLock.installs.find((entry) => entry.id === plan.id)!;
      updated.version = plan.toVersion;
      updated.source = plan.provenance;
      updated.target = plan.target;
      updated.files = plan.changes
        .filter((change) => change.kind !== 'orphan')
        .map((change) => ({ path: change.path, sha256: change.afterSha256! }))
        .sort((left, right) => comparePath(left.path, right.path));
    }
    nextLock.installs.sort((left, right) => comparePath(left.id, right.id));

    const lockedElsewhere = new Set(
      lock.installs
        .filter((entry) => !plans.some((plan) => plan.id === entry.id))
        .flatMap((entry) => entry.files.map((file) => file.path)),
    );
    const writes: Array<{ plan: ArtifactPlan; change: PlannedChange }> = [];
    for (const plan of plans) {
      for (const change of plan.changes) {
        if (change.kind === 'orphan') continue;
        if (lockedElsewhere.has(change.path))
          throw new InstallError(
            `La destination « ${change.path} » appartient à une autre entrée du lock.`,
          );
        if (change.unmanagedConflict)
          throw new InstallError(
            `Conflit : « ${change.path} » existe sans être géré par ce skill ; il ne sera jamais remplacé, même avec --force.`,
          );
        if (change.localConflict && !force)
          throw new InstallError(
            `Conflit local : « ${change.path} » a été modifié ou supprimé. Aucun fichier n’a été remplacé ; utiliser --force après revue.`,
          );
        const disk = await readSnapshot(projectRoot, change.path);
        if (change.currentIdentity) {
          if (
            !disk ||
            disk.device !== change.currentIdentity.device ||
            disk.inode !== change.currentIdentity.inode ||
            digest(disk.contents) !== change.beforeSha256
          ) {
            throw new InstallError(
              `La destination « ${change.path} » a changé après l’aperçu ; aucune écriture effectuée.`,
            );
          }
        } else if (disk) {
          throw new InstallError(
            `La destination « ${change.path} » est apparue après l’aperçu ; elle reste intacte.`,
          );
        }
        if (!disk || disk.sha256 !== change.afterSha256)
          writes.push({ plan, change });
      }
    }

    if (force) {
      for (const { change } of writes) {
        if (!change.localConflict || !change.currentContents) continue;
        const backupPath = await writeBackup(
          projectRoot,
          transaction,
          change.path,
          change.currentContents,
          createdDirectories,
        );
        backupPaths.push(backupPath);
      }
    }

    for (const { change } of writes) {
      validateProjectPath(change.path);
      await ensureDirectoryChain(
        projectRoot,
        path.posix.dirname(change.path),
        createdDirectories,
      );
      await assertRootIdentity(projectRoot, rootDevice, rootInode);
      await options.onBeforeFileCommit?.(change.path);
      const parentChain = await captureParentChain(
        projectRoot,
        rootDevice,
        rootInode,
        change.path,
      );
      const current = await readSnapshot(projectRoot, change.path);
      if (change.currentIdentity) {
        if (
          !current ||
          current.device !== change.currentIdentity.device ||
          current.inode !== change.currentIdentity.inode ||
          current.sha256 !== change.beforeSha256
        ) {
          throw new InstallError(
            `Le contenu local de « ${change.path} » a changé pendant l’opération ; écriture annulée.`,
          );
        }
      } else if (current) {
        throw new InstallError(
          `La destination « ${change.path} » est apparue pendant l’opération ; elle reste intacte.`,
        );
      }
      const mutation: FileMutation = {
        path: change.path,
        oldContents: change.currentContents,
        ...parentChain,
      };
      mutations.push(mutation);
      mutation.newIdentity = await atomicWrite(
        projectRoot,
        change.path,
        change.nextContents!,
        change.currentIdentity,
      );
    }

    await assertRootIdentity(projectRoot, rootDevice, rootInode);
    await options.onBeforeLockCommit?.();
    for (const plan of plans) {
      for (const change of plan.changes) {
        if (change.kind === 'orphan') continue;
        const current = await readSnapshot(projectRoot, change.path);
        const mutation = mutations.find((item) => item.path === change.path);
        const expectedIdentity =
          mutation?.newIdentity ?? change.currentIdentity;
        if (
          !current ||
          current.sha256 !== change.afterSha256 ||
          !expectedIdentity ||
          current.device !== expectedIdentity.device ||
          current.inode !== expectedIdentity.inode
        ) {
          throw new InstallError(
            `L’état de « ${change.path} » a changé avant l’écriture du lock ; mise à jour annulée.`,
          );
        }
      }
    }
    const lockPath = path.join(projectRoot, lockName);
    let oldLockIdentity: { device: number; inode: number } | undefined;
    try {
      const details = await lstat(lockPath);
      if (details.isSymbolicLink() || !details.isFile())
        throw new InstallError(`${lockName} n’est pas un fichier ordinaire.`);
      oldLockIdentity = { device: details.dev, inode: details.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const rawLock = await readFile(lockPath).catch(
      (error: NodeJS.ErrnoException) =>
        error.code === 'ENOENT' ? undefined : Promise.reject(error),
    );
    if (oldLockIdentity && !rawLock)
      throw new InstallError(`${lockName} a disparu avant son remplacement.`);
    if (
      !oldLockIdentity ||
      oldLockIdentity.device !== originalLock.device ||
      oldLockIdentity.inode !== originalLock.inode ||
      !rawLock?.equals(originalLock.contents)
    ) {
      throw new InstallError(
        `${lockName} a changé pendant l’opération ; lock concurrent préservé.`,
      );
    }
    await atomicWrite(
      projectRoot,
      lockName,
      Buffer.from(`${JSON.stringify(nextLock, null, 2)}\n`),
      oldLockIdentity,
    );
    const orphanPaths = plans.flatMap((plan) =>
      plan.changes
        .filter((change) => change.kind === 'orphan')
        .map((change) => change.path),
    );
    return [
      ...backupPaths.map((backup) => `Sauvegarde : ${backup}`),
      ...orphanPaths.map(
        (orphan) => `Orphelin conservé (non supprimé) : ${orphan}`,
      ),
    ];
  } catch (error) {
    const rollbackWarnings = await rollbackMutations(
      projectRoot,
      rootDevice,
      rootInode,
      mutations,
      createdDirectories,
    );
    const suffix = rollbackWarnings.length
      ? ` Rollback incomplet ; éléments préservés : ${rollbackWarnings.join(' ; ')}`
      : mutations.length
        ? ' Les fichiers et le lock précédents ont été restaurés.'
        : ' Aucune écriture de mise à jour n’a eu lieu.';
    throw new InstallError(
      `${error instanceof Error ? error.message : String(error)}${suffix}`,
    );
  }
}

function printHumanPlan(plans: ArtifactPlan[]): void {
  for (const plan of plans) {
    console.log(`${plan.id} : ${plan.fromVersion} → ${plan.toVersion}`);
    console.log(`Provenance du dépôt : ${plan.provenance}`);
    console.log(`Source locale lue : ${plan.sourceLocal}`);
    console.log(`Cible : ${plan.target}/${plan.id}`);
    for (const change of plan.changes) {
      const labels = {
        added: 'ajout',
        modified: 'modification',
        unchanged: 'inchangé',
        orphan: 'orphelin (conservé)',
      };
      console.log(
        `  ${labels[change.kind]}${change.localConflict ? ' — conflit local' : ''} : ${change.path}`,
      );
      if (change.source)
        console.log(`    Fichier catalogue : ${change.source}`);
      if (change.diff) console.log(change.diff);
    }
  }
}

export async function runUpdateCommand(
  args: string[],
  options: ProjectCommandOptions = {},
): Promise<void> {
  const parsed = parseUpdateArgs(args);
  const project = await ensureProjectRoot(options.project ?? parsed.project);
  const release = await acquireProjectLock(project, options.onProjectLockWait);
  try {
    const lock = await readLock(project);
    let originalLock: LockSnapshot | undefined;
    try {
      const currentLockDetails = await lstat(path.join(project, lockName));
      if (currentLockDetails.isSymbolicLink() || !currentLockDetails.isFile()) {
        throw new InstallError(`${lockName} n’est pas un fichier ordinaire.`);
      }
      originalLock = {
        contents: await readFile(path.join(project, lockName)),
        device: currentLockDetails.dev,
        inode: currentLockDetails.ino,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const selected = parsed.id
      ? lock.installs.filter((entry) => entry.id === parsed.id)
      : lock.installs;
    if (parsed.id && selected.length === 0)
      throw new InstallError(
        `« ${parsed.id} » ne figure pas dans ${lockName}.`,
      );
    const root = options.catalogRoot ?? sourceRoot;
    const artifacts = (await loadCatalog(root)) as unknown as Artifact[];
    const catalog = new Map(
      artifacts.map((artifact) => [artifact.id, artifact]),
    );
    const unavailable = selected.find((entry) => {
      const artifact = catalog.get(entry.id);
      return !artifact || !newestStable(artifact);
    });
    if (unavailable) {
      throw new InstallError(
        `Aucune version stable disponible dans le catalogue pour « ${unavailable.id} » ; aucune mise à jour effectuée.`,
      );
    }
    const plans = (
      await Promise.all(
        selected.map((entry) =>
          makeArtifactPlan(project, entry, catalog.get(entry.id), root),
        ),
      )
    ).filter((plan): plan is ArtifactPlan => plan !== undefined);
    if (plans.length === 0) {
      const result = parsed.id
        ? `${parsed.id} est déjà à jour.`
        : 'Aucune mise à jour stable disponible.';
      if (parsed.json) console.log(JSON.stringify([], null, 2));
      else console.log(result);
      return;
    }
    if (!parsed.json) printHumanPlan(plans);
    const conflicts = plans.flatMap((plan) =>
      plan.changes.filter(
        (change) => change.localConflict && change.kind !== 'orphan',
      ),
    );
    if (conflicts.length && !parsed.force) {
      if (parsed.json)
        console.log(JSON.stringify(plans.map(serializePlan), null, 2));
      throw new InstallError(
        `${conflicts.length} conflit(s) local(aux) détecté(s). Aperçu seulement ; aucun fichier modifié. Utiliser --force pour sauvegarder les fichiers locaux avant remplacement.`,
      );
    }
    const interactive = options.interactive ?? stdin.isTTY;
    if (!parsed.confirmed && !interactive) {
      if (parsed.json)
        console.log(JSON.stringify(plans.map(serializePlan), null, 2));
      throw new InstallError(
        'Mise à jour non interactive : confirmer explicitement avec --yes ou --non-interactive.',
      );
    }
    const confirmed =
      parsed.confirmed ||
      (options.confirm
        ? await options.confirm()
        : await confirmUpdate(false, interactive));
    if (!confirmed) {
      if (parsed.json)
        console.log(
          JSON.stringify(
            { applied: false, plans: plans.map(serializePlan) },
            null,
            2,
          ),
        );
      else console.log('Mise à jour annulée.');
      return;
    }
    if (!originalLock) {
      throw new InstallError(
        `${lockName} a disparu avant l’application ; aucune écriture effectuée.`,
      );
    }
    const notes = await withProcessCwdLock(() =>
      applyPlans(project, lock, originalLock, plans, parsed.force, options),
    );
    if (parsed.json) {
      console.log(
        JSON.stringify(
          { applied: true, plans: plans.map(serializePlan), notes },
          null,
          2,
        ),
      );
    } else {
      for (const note of notes) console.log(note);
      console.log(
        `Mis à jour : ${plans.map((plan) => `${plan.id}@${plan.toVersion}`).join(', ')}.`,
      );
    }
  } finally {
    await release();
  }
}
