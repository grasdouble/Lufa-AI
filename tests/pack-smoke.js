import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  throw new Error('Lancer le smoke test via `npm run pack:smoke`.');
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'lufa-pack-smoke-'));
const tarballDirectory = path.join(temporaryRoot, 'tarball');
const consumerDirectory = path.join(temporaryRoot, 'consumer');
const projectDirectory = path.join(consumerDirectory, 'fixture-project');

await Promise.all([
  mkdir(tarballDirectory),
  mkdir(projectDirectory, { recursive: true }),
]);

function runNpm(args, cwd) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: 'utf8',
    env: process.env,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `npm ${args.join(' ')} a échoué :\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.trim();
}

try {
  const packResult = JSON.parse(
    runNpm(
      ['pack', '--json', '--pack-destination', tarballDirectory],
      repositoryRoot,
    ),
  );
  assert.equal(packResult.length, 1);
  const tarballPath = path.join(tarballDirectory, packResult[0].filename);

  await stat(tarballPath);
  for (const requiredFile of [
    'dist/lufa-command.js',
    'dist/package-root.js',
    'schemas/artifact.schema.json',
    'generated/catalog-index.json',
    'catalog/hello-agent/versions/1.2.0/SKILL.md',
  ]) {
    assert.ok(
      packResult[0].files.some((file) => file.path === requiredFile),
      `Le tarball ne contient pas ${requiredFile}.`,
    );
  }

  runNpm(
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--prefix',
      consumerDirectory,
      tarballPath,
    ],
    consumerDirectory,
  );

  const installedPackageRoot = path.join(
    consumerDirectory,
    'node_modules',
    'lufa-ai',
  );
  await stat(path.join(installedPackageRoot, 'dist/lufa-command.js'));
  await assert.rejects(stat(path.join(installedPackageRoot, 'src')));

  const list = JSON.parse(
    runNpm(['exec', '--', 'lufa', 'list', '--json'], consumerDirectory),
  );
  assert.ok(list.some((artifact) => artifact.id === 'hello-agent'));

  const shown = JSON.parse(
    runNpm(
      ['exec', '--', 'lufa', 'show', 'hello-agent', '--json'],
      consumerDirectory,
    ),
  );
  assert.equal(shown.id, 'hello-agent');

  runNpm(
    [
      'exec',
      '--',
      'lufa',
      'install',
      'hello-agent',
      '--yes',
      '--project',
      projectDirectory,
    ],
    consumerDirectory,
  );
  const installedSkill = await readFile(
    path.join(projectDirectory, '.agents/skills/hello-agent/SKILL.md'),
    'utf8',
  );
  assert.match(installedSkill, /Hello Agent/);
  const lock = JSON.parse(
    await readFile(path.join(projectDirectory, 'lufa.lock.json'), 'utf8'),
  );
  assert.equal(lock.installs[0].id, 'hello-agent');

  console.log(
    'Smoke tarball npm : liste, détail et installation depuis le consommateur isolé OK.',
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
