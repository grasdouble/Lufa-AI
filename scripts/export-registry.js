import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCatalogIndex,
  CatalogValidationError,
  validateCatalog,
} from '../src/catalog.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const catalogRoot = path.join(projectRoot, 'catalog');
const webRoot = path.join(projectRoot, 'web');
const publicRoot = path.join(projectRoot, 'web', 'public');
const registryRoot = path.join(publicRoot, 'registry');
const generatedRoot = path.join(projectRoot, 'generated');
const indexPath = path.join(projectRoot, 'generated', 'catalog-index.json');

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

async function assertNoSymlinks(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const entryStat = await lstat(entryPath);
    if (entryStat.isSymbolicLink()) {
      throw new CatalogValidationError(
        `Lien symbolique interdit dans le catalogue : ${entryPath}.`,
      );
    }
    if (entryStat.isDirectory()) {
      await assertNoSymlinks(entryPath);
    } else if (!entryStat.isFile()) {
      throw new CatalogValidationError(
        `Entrée catalogue non régulière interdite : ${entryPath}.`,
      );
    }
  }
}

async function prepareRegistryDirectory() {
  const webStat = await lstat(webRoot);
  const resolvedProject = await realpath(projectRoot);
  const resolvedWeb = await realpath(webRoot);
  if (
    webStat.isSymbolicLink() ||
    !webStat.isDirectory() ||
    !isWithin(resolvedProject, resolvedWeb)
  ) {
    throw new CatalogValidationError(
      `Le dossier web « ${webRoot} » doit être un dossier réel du dépôt.`,
    );
  }

  await mkdir(publicRoot, { recursive: true });
  const publicStat = await lstat(publicRoot);
  if (publicStat.isSymbolicLink() || !publicStat.isDirectory()) {
    throw new CatalogValidationError(
      `Le dossier public « ${publicRoot} » doit être un dossier réel.`,
    );
  }

  try {
    const registryStat = await lstat(registryRoot);
    if (registryStat.isSymbolicLink() || !registryStat.isDirectory()) {
      throw new CatalogValidationError(
        `La sortie « ${registryRoot} » doit être un dossier réel.`,
      );
    }
    const resolvedPublic = await realpath(publicRoot);
    const resolvedRegistry = await realpath(registryRoot);
    if (!isWithin(resolvedPublic, resolvedRegistry)) {
      throw new CatalogValidationError(
        `La sortie « ${registryRoot} » sort du dossier public.`,
      );
    }
    await rm(registryRoot, { recursive: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(path.join(registryRoot, 'catalog'), { recursive: true });
}

async function main() {
  await validateCatalog(projectRoot);
  await assertNoSymlinks(catalogRoot);

  const generatedStat = await lstat(generatedRoot);
  const indexStat = await lstat(indexPath);
  const resolvedGenerated = await realpath(generatedRoot);
  const resolvedIndex = await realpath(indexPath);
  const resolvedProject = await realpath(projectRoot);
  if (
    generatedStat.isSymbolicLink() ||
    !generatedStat.isDirectory() ||
    indexStat.isSymbolicLink() ||
    !indexStat.isFile() ||
    !isWithin(resolvedProject, resolvedGenerated) ||
    !isWithin(resolvedGenerated, resolvedIndex)
  ) {
    throw new CatalogValidationError(
      'Le dossier generated/catalog-index.json doit être un fichier réel du dépôt.',
    );
  }

  const committedIndex = await readFile(indexPath, 'utf8');
  const expectedIndex = await buildCatalogIndex(projectRoot);
  if (committedIndex !== expectedIndex) {
    throw new CatalogValidationError(
      'Index absent, périmé ou non déterministe ; exécuter npm run catalog:build.',
    );
  }

  const { artifacts } = JSON.parse(committedIndex);
  await prepareRegistryDirectory();
  await writeFile(
    path.join(registryRoot, 'catalog-index.json'),
    committedIndex,
  );

  for (const artifact of artifacts) {
    for (const version of artifact.versions) {
      for (const file of version.files) {
        const sourcePath = path.resolve(
          catalogRoot,
          artifact.id,
          ...file.path.split('/'),
        );
        const resolvedSource = await realpath(sourcePath);
        const artifactRoot = await realpath(
          path.join(catalogRoot, artifact.id),
        );
        if (!isWithin(artifactRoot, resolvedSource)) {
          throw new CatalogValidationError(
            `Fichier catalogue sortant du paquet : ${artifact.id}/${file.path}.`,
          );
        }

        const destination = path.join(
          registryRoot,
          'catalog',
          artifact.id,
          ...file.path.split('/'),
        );
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, await readFile(resolvedSource));
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
