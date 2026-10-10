import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const committedDirectory = path.join(repositoryRoot, 'dist');
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), 'lufa-build-check-'),
);
const generatedDirectory = path.join(temporaryRoot, 'dist');
const typescriptCli = fileURLToPath(
  new URL('../node_modules/typescript/bin/tsc', import.meta.url),
);

async function listFiles(directory, prefix = '') {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolute, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`Sortie TypeScript inattendue : ${absolute}`);
    }
  }
  return files.sort();
}

try {
  const result = spawnSync(
    process.execPath,
    [typescriptCli, '--outDir', generatedDirectory],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `La compilation TypeScript a échoué :\n${result.stdout}\n${result.stderr}`,
  );

  const [committedFiles, generatedFiles] = await Promise.all([
    listFiles(committedDirectory),
    listFiles(generatedDirectory),
  ]);
  const committedSet = new Set(committedFiles);
  const generatedSet = new Set(generatedFiles);
  const missing = generatedFiles.filter((file) => !committedSet.has(file));
  const extra = committedFiles.filter((file) => !generatedSet.has(file));
  const different = [];

  for (const file of generatedFiles) {
    if (!committedSet.has(file)) continue;
    const [committed, generated] = await Promise.all([
      readFile(path.join(committedDirectory, file)),
      readFile(path.join(generatedDirectory, file)),
    ]);
    if (!committed.equals(generated)) different.push(file);
  }

  if (missing.length || extra.length || different.length) {
    console.error('dist/ ne correspond pas au build TypeScript actuel.');
    for (const [label, files] of [
      ['Absents de dist/', missing],
      ['Supplémentaires dans dist/', extra],
      ['Contenu différent dans dist/', different],
    ]) {
      if (files.length) console.error(`${label}\n  ${files.join('\n  ')}`);
    }
    console.error(
      'Exécutez `npm run build`, puis incluez dist/ dans le commit.',
    );
    process.exitCode = 1;
  } else {
    console.log('dist/ correspond au build TypeScript actuel.');
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
