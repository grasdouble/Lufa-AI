import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cliPath = fileURLToPath(
  new URL('../src/lufa-command.ts', import.meta.url),
);
const indexPath = new URL('../generated/catalog-index.json', import.meta.url);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function runCli(args, cwd) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', cliPath, ...args],
    { cwd, encoding: 'utf8' },
  );
}

async function withEmptyProject(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'lufa-cli-test-'));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('list prints indexed artifacts and stable JSON summaries without project writes', async () => {
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const expected = index.artifacts.map((artifact) => ({
    id: artifact.id,
    name: artifact.name,
    description: artifact.description,
    type: artifact.type,
    categories: artifact.discovery.categories,
    keywords: artifact.discovery.keywords,
    versions: artifact.versions.map(({ version }) => version),
  }));

  await withEmptyProject(async (cwd) => {
    const first = runCli(['list', '--json'], cwd);
    const second = runCli(['list', '--json'], cwd);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, second.stdout);
    assert.deepEqual(JSON.parse(first.stdout), expected);

    const text = runCli(['list'], cwd);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /hello-agent\s+Hello Agent/);
    assert.deepEqual(await readdir(cwd), []);
  });
});

test('npm silent invocation produces pipeline-safe JSON without banners', () => {
  const result = spawnSync(
    'npm',
    ['run', '--silent', 'lufa', '--', 'list', '--json'],
    { cwd: projectRoot, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^\[/);
  assert.doesNotMatch(result.stdout, /^>/);
  assert.ok(Array.isArray(JSON.parse(result.stdout)));
});

test('search matches case-insensitively across names, descriptions, categories and keywords', async () => {
  await withEmptyProject(async (cwd) => {
    for (const term of [
      'hElLo aGeNt',
      'HELLO-AGENT',
      'ACCUEIL',
      'WRITING',
      'GREETING',
    ]) {
      const result = runCli(['search', term, '--json'], cwd);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        JSON.parse(result.stdout).map(({ id }) => id),
        ['hello-agent'],
      );
    }

    const missing = runCli(['search', 'not-in-catalog'], cwd);
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, /Aucun artefact trouvé/);
    assert.deepEqual(await readdir(cwd), []);
  });
});

test('show prints the complete artifact detail, including provenance and version metadata', async () => {
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const [expectedArtifact] = index.artifacts;
  const expectedDetail = {
    ...expectedArtifact,
    installation: {
      command: 'lufa install hello-agent',
      status: 'available',
      note: 'Installe la dernière version stable ; utilisez @<version> pour choisir une version précise.',
    },
  };

  await withEmptyProject(async (cwd) => {
    const first = runCli(['show', 'hello-agent', '--json'], cwd);
    const second = runCli(['show', 'hello-agent', '--json'], cwd);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, second.stdout);
    assert.deepEqual(JSON.parse(first.stdout), expectedDetail);

    const text = runCli(['show', 'hello-agent'], cwd);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Dépôt : https:\/\/github\.com/);
    assert.match(text.stdout, /Version 1\.0\.0/);
    assert.match(
      text.stdout,
      /versions\/1\.0\.0\/SKILL\.md → \.agents\/skills\/hello-agent\/SKILL\.md/,
    );
    assert.match(text.stdout, /github-copilot : declared/);
    assert.match(text.stdout, /Prérequis : aucun/);
    assert.match(text.stdout, /Avertissements : Compatibilité déclarée/);
    assert.match(text.stdout, /Installation : lufa install hello-agent/);
    assert.deepEqual(await readdir(cwd), []);
  });
});

test('unknown artifacts, commands, missing arguments and invalid options have actionable errors', async () => {
  await withEmptyProject(async (cwd) => {
    const unknownArtifact = runCli(['show', 'missing-skill'], cwd);
    assert.equal(unknownArtifact.status, 1);
    assert.match(unknownArtifact.stderr, /Artefact inconnu « missing-skill »/);
    assert.match(unknownArtifact.stderr, /npm run lufa -- list/);

    const unknownCommand = runCli(['remove', 'hello-agent'], cwd);
    assert.notEqual(unknownCommand.status, 0);
    assert.match(unknownCommand.stderr, /Commande inconnue « remove »/);
    assert.match(unknownCommand.stderr, /list, search, show, install/);

    const missingSearchTerm = runCli(['search'], cwd);
    assert.notEqual(missingSearchTerm.status, 0);
    assert.match(
      missingSearchTerm.stderr,
      /Usage : npm run lufa -- search <terme>/,
    );

    const missingId = runCli(['show'], cwd);
    assert.notEqual(missingId.status, 0);
    assert.match(
      missingId.stderr,
      /Usage : npm run lufa -- show <identifiant>/,
    );

    const unknownOption = runCli(['list', '--yaml'], cwd);
    assert.notEqual(unknownOption.status, 0);
    assert.match(unknownOption.stderr, /Option inconnue « --yaml »/);
  });
});

test('help is available without reading or changing the project', async () => {
  await withEmptyProject(async (cwd) => {
    const result = runCli(['--help'], cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /list \[--json\]/);
    assert.match(result.stdout, /search <terme>/);
    assert.match(result.stdout, /show <identifiant>/);
    assert.match(result.stdout, /install <identifiant\[@version\]>/);
    assert.deepEqual(await readdir(cwd), []);
  });
});
