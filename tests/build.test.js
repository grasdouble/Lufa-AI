import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rename } from 'node:fs/promises';
import { test } from 'node:test';
import { build } from '../scripts/build-lib.js';

async function createBuildRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lufa-build-test-'));
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'dist', 'sentinel.txt'), 'previous build');
  return root;
}

async function assertNoBuildTemporaryDirectories(root) {
  const entries = await readdir(root);
  assert.deepEqual(entries.sort(), ['dist']);
}

test('a failed partial compilation preserves dist and cleans temporary output', async (t) => {
  const root = await createBuildRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    build({
      root,
      compiler: async (outputDirectory) => {
        await mkdir(outputDirectory);
        await writeFile(path.join(outputDirectory, 'partial.js'), 'partial');
        return { status: 1 };
      },
    }),
    /compilation TypeScript a échoué \(1\)/,
  );

  assert.equal(
    await readFile(path.join(root, 'dist', 'sentinel.txt'), 'utf8'),
    'previous build',
  );
  assert.deepEqual(await readdir(path.join(root, 'dist')), ['sentinel.txt']);
  await assertNoBuildTemporaryDirectories(root);
});

test('a successful compilation replaces dist and cleans temporary output', async (t) => {
  const root = await createBuildRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  await build({
    root,
    compiler: async (outputDirectory) => {
      await mkdir(outputDirectory);
      await writeFile(path.join(outputDirectory, 'new.js'), 'new build');
    },
  });

  assert.deepEqual(await readdir(path.join(root, 'dist')), ['new.js']);
  assert.equal(
    await readFile(path.join(root, 'dist', 'new.js'), 'utf8'),
    'new build',
  );
  await assertNoBuildTemporaryDirectories(root);
});

test('a failed dist commit restores the previous build and cleans temporary output', async (t) => {
  const root = await createBuildRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  let failCommit = true;

  await assert.rejects(
    build({
      root,
      compiler: async (outputDirectory) => {
        await mkdir(outputDirectory);
        await writeFile(path.join(outputDirectory, 'new.js'), 'new build');
      },
      renamePath: async (from, to) => {
        if (path.basename(from) === 'output' && failCommit) {
          failCommit = false;
          throw new Error('simulated commit rename failure');
        }
        await rename(from, to);
      },
    }),
    /simulated commit rename failure/,
  );

  assert.deepEqual(await readdir(path.join(root, 'dist')), ['sentinel.txt']);
  assert.equal(
    await readFile(path.join(root, 'dist', 'sentinel.txt'), 'utf8'),
    'previous build',
  );
  await assertNoBuildTemporaryDirectories(root);
});
