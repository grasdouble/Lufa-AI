import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { DEFAULT_REGISTRY_URL, getRegistryUrl } from '../src/registry-index.ts';
import { createRegistryFixture } from './registry-fixture.js';

const cliPath = fileURLToPath(
  new URL('../src/lufa-command.ts', import.meta.url),
);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const bundledIndex = JSON.parse(
  await readFile(
    new URL('../generated/catalog-index.json', import.meta.url),
    'utf8',
  ),
);
const registry = await createRegistryFixture(bundledIndex);

after(async () => registry.close());

function cli(args, cwd, cacheDirectory) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', cliPath, ...args],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        LUFA_REGISTRY_URL: registry.url,
        LUFA_CACHE_DIR: cacheDirectory,
      },
      timeout: 10_000,
    },
  );
}

async function withCache(callback) {
  const cacheDirectory = await mkdtemp(
    path.join(tmpdir(), 'lufa-registry-cache-'),
  );
  try {
    await callback(cacheDirectory);
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
}

function changedIndex(id = 'remote-only-artifact') {
  const index = structuredClone(bundledIndex);
  index.artifacts[0].id = id;
  index.artifacts[0].name = 'Remote registry artifact';
  index.artifacts[0].versions[0].files[0].path =
    'versions/99.0.0/not-present-in-the-package.md';
  return index;
}

function validCache(id = 'cached-link-target') {
  const index = structuredClone(bundledIndex);
  index.artifacts[0].id = id;
  return JSON.stringify({ cachedAt: new Date().toISOString(), index });
}

function isUnsupportedWindowsSymlink(t, error) {
  if (process.platform === 'win32' && error.code === 'EPERM') {
    t.skip(
      'Le runner Windows ne permet pas la création de ce lien symbolique.',
    );
    return true;
  }
  return false;
}

test('HTTP override is accepted only for strict loopback; HTTPS custom registries remain valid', () => {
  assert.equal(
    getRegistryUrl('http://localhost:8080/index.json').protocol,
    'http:',
  );
  assert.equal(
    getRegistryUrl('http://127.0.0.1:8080/index.json').hostname,
    '127.0.0.1',
  );
  assert.equal(
    getRegistryUrl('http://127.255.255.254:8080/index.json').protocol,
    'http:',
  );
  assert.equal(
    getRegistryUrl('http://[::1]:8080/index.json').protocol,
    'http:',
  );
  assert.throws(
    () => getRegistryUrl('http://evil.example/index.json'),
    /loopback/,
  );
  assert.throws(
    () => getRegistryUrl('http://localhost.evil.example/index.json'),
    /loopback/,
  );
  assert.equal(
    getRegistryUrl('https://registry.example/index.json').protocol,
    'https:',
  );
  assert.equal(
    getRegistryUrl(DEFAULT_REGISTRY_URL).hostname,
    'grasdouble.github.io',
  );
});

test('consultation refreshes from HTTP, keeps JSON stdout clean, and sends no project data', async () => {
  await withCache(async (cacheDirectory) => {
    const projectDirectory = await mkdtemp(
      path.join(tmpdir(), 'private-project-name-'),
    );
    try {
      await registry.setResponse(changedIndex());
      const result = cli(['list', '--json'], projectDirectory, cacheDirectory);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        JSON.parse(result.stdout).map(({ id }) => id),
        ['remote-only-artifact'],
      );
      assert.match(result.stderr, /distant actualisé/);
      assert.equal(
        JSON.parse(
          await readFile(
            path.join(cacheDirectory, 'catalog-index-cache.json'),
            'utf8',
          ),
        ).index.artifacts[0].id,
        'remote-only-artifact',
      );

      const requests = await registry.requests();
      const registryRequests = requests.filter(
        ({ url }) => url === '/registry/catalog-index.json',
      );
      assert.ok(registryRequests.length > 0);
      for (const request of registryRequests) {
        assert.equal(request.method, 'GET');
        assert.equal(request.body, '');
        assert.doesNotMatch(
          JSON.stringify(request.headers),
          /private-project-name/,
        );
      }
    } finally {
      await rm(projectDirectory, { recursive: true, force: true });
    }
  });
});

test('outage falls back to the last validated cache with an explicit stale warning', async () => {
  await withCache(async (cacheDirectory) => {
    await registry.setResponse(changedIndex('cached-registry-artifact'));
    const fresh = cli(['list', '--json'], repoRoot, cacheDirectory);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.deepEqual(
      JSON.parse(fresh.stdout).map(({ id }) => id),
      ['cached-registry-artifact'],
    );

    await registry.setResponse({ unavailable: true }, 503);
    const fallback = cli(['list', '--json'], repoRoot, cacheDirectory);
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.deepEqual(
      JSON.parse(fallback.stdout).map(({ id }) => id),
      ['cached-registry-artifact'],
    );
    assert.match(fallback.stderr, /AVERTISSEMENT/);
    assert.match(fallback.stderr, /cache du .* potentiellement périmé/);
  });
});

test('an invalid remote index falls back to cache and leaves stdout parseable JSON', async () => {
  await withCache(async (cacheDirectory) => {
    await registry.setResponse(changedIndex('validated-cache-artifact'));
    const seed = cli(
      ['search', 'Remote registry', '--json'],
      repoRoot,
      cacheDirectory,
    );
    assert.equal(seed.status, 0, seed.stderr);

    await registry.setResponse({ schemaVersion: 99, artifacts: [] });
    const fallback = cli(['list', '--json'], repoRoot, cacheDirectory);
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.deepEqual(
      JSON.parse(fallback.stdout).map(({ id }) => id),
      ['validated-cache-artifact'],
    );
    assert.match(fallback.stderr, /Index distant est invalide/);
    assert.match(fallback.stderr, /potentiellement périmé/);
  });
});

test('a corrupt cache is rejected and outage falls back to bundled snapshot', async () => {
  await withCache(async (cacheDirectory) => {
    await writeFile(
      path.join(cacheDirectory, 'catalog-index-cache.json'),
      '{ definitely not json',
    );
    await registry.setResponse({ unavailable: true }, 503);
    const result = cli(['list', '--json'], repoRoot, cacheDirectory);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout).map(({ id }) => id),
      ['hello-agent'],
    );
    assert.match(result.stderr, /Cache d’index illisible/);
    assert.match(result.stderr, /instantané embarqué, potentiellement périmé/);
  });
});

test('an unsafe remote artifact path is rejected before use', async () => {
  await withCache(async (cacheDirectory) => {
    const unsafe = structuredClone(bundledIndex);
    unsafe.artifacts[0].versions[0].files[0].path = '../outside.md';
    await registry.setResponse(unsafe);
    const result = cli(['list', '--json'], repoRoot, cacheDirectory);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout).map(({ id }) => id),
      ['hello-agent'],
    );
    assert.match(result.stderr, /chemin dangereux/);
    assert.match(result.stderr, /instantané embarqué, potentiellement périmé/);
  });
});

test('cache directory symlinks are ignored for reads and never used for writes', async (t) => {
  await withCache(async (cacheDirectory) => {
    const targetDirectory = path.join(cacheDirectory, 'real-cache');
    const linkedDirectory = path.join(cacheDirectory, 'linked-cache');
    await mkdir(targetDirectory);
    const targetCache = path.join(targetDirectory, 'catalog-index-cache.json');
    const originalCache = validCache();
    await writeFile(targetCache, originalCache);
    try {
      await symlink(
        targetDirectory,
        linkedDirectory,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (isUnsupportedWindowsSymlink(t, error)) return;
      throw error;
    }

    await registry.setResponse({ unavailable: true }, 503);
    const outage = cli(['list', '--json'], repoRoot, linkedDirectory);
    assert.equal(outage.status, 0, outage.stderr);
    assert.deepEqual(
      JSON.parse(outage.stdout).map(({ id }) => id),
      ['hello-agent'],
    );
    assert.match(outage.stderr, /chemin du cache contient un lien symbolique/);
    assert.equal(await readFile(targetCache, 'utf8'), originalCache);

    await registry.setResponse(changedIndex('fresh-through-symlink-test'));
    const refreshed = cli(['list', '--json'], repoRoot, linkedDirectory);
    assert.equal(refreshed.status, 0, refreshed.stderr);
    assert.deepEqual(
      JSON.parse(refreshed.stdout).map(({ id }) => id),
      ['fresh-through-symlink-test'],
    );
    assert.match(refreshed.stderr, /cache local n’a pas pu être écrit/);
    assert.equal(await readFile(targetCache, 'utf8'), originalCache);
  });
});

test('cache file symlinks are rejected and cannot redirect cache reads', async (t) => {
  await withCache(async (cacheDirectory) => {
    const targetCache = path.join(cacheDirectory, 'target.json');
    const cachePath = path.join(cacheDirectory, 'catalog-index-cache.json');
    const originalCache = validCache();
    await writeFile(targetCache, originalCache);
    try {
      await symlink(
        targetCache,
        cachePath,
        process.platform === 'win32' ? 'file' : undefined,
      );
    } catch (error) {
      if (isUnsupportedWindowsSymlink(t, error)) return;
      throw error;
    }

    await registry.setResponse({ unavailable: true }, 503);
    const result = cli(['list', '--json'], repoRoot, cacheDirectory);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout).map(({ id }) => id),
      ['hello-agent'],
    );
    assert.match(result.stderr, /fichier de cache est un lien symbolique/);
    assert.equal(await readFile(targetCache, 'utf8'), originalCache);
    assert.equal((await lstat(cachePath)).isSymbolicLink(), true);

    await registry.setResponse(changedIndex('fresh-with-cache-file-link'));
    const refreshed = cli(['list', '--json'], repoRoot, cacheDirectory);
    assert.equal(refreshed.status, 0, refreshed.stderr);
    assert.deepEqual(
      JSON.parse(refreshed.stdout).map(({ id }) => id),
      ['fresh-with-cache-file-link'],
    );
    assert.match(refreshed.stderr, /cache local n’a pas pu être écrit/);
    assert.equal(await readFile(targetCache, 'utf8'), originalCache);
    assert.equal((await lstat(cachePath)).isSymbolicLink(), true);
  });
});

test('oversized cache and remote response are rejected before parsing', async () => {
  await withCache(async (cacheDirectory) => {
    const cachePath = path.join(cacheDirectory, 'catalog-index-cache.json');
    await writeFile(cachePath, Buffer.alloc(5 * 1024 * 1024 + 1, 0x20));
    await registry.setResponse({ unavailable: true }, 503);
    const cachedFallback = cli(['list', '--json'], repoRoot, cacheDirectory);
    assert.equal(cachedFallback.status, 0, cachedFallback.stderr);
    assert.deepEqual(
      JSON.parse(cachedFallback.stdout).map(({ id }) => id),
      ['hello-agent'],
    );
    assert.match(
      cachedFallback.stderr,
      /cache d’index dépasse la taille autorisée/,
    );

    await registry.setResponse(' '.repeat(5 * 1024 * 1024 + 1));
    const remoteFallback = cli(['list', '--json'], repoRoot, cacheDirectory);
    assert.equal(remoteFallback.status, 0, remoteFallback.stderr);
    assert.deepEqual(
      JSON.parse(remoteFallback.stdout).map(({ id }) => id),
      ['hello-agent'],
    );
    assert.match(
      remoteFallback.stderr,
      /index distant dépasse la taille autorisée/,
    );
  });
});

test('HTTP redirects are refused and fall back without following Location', async () => {
  await withCache(async (cacheDirectory) => {
    const redirectTarget = new URL(
      '/registry/redirect-target.json',
      registry.url,
    ).href;
    await registry.setResponse('', 302, { location: redirectTarget });
    const result = cli(['list', '--json'], repoRoot, cacheDirectory);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout).map(({ id }) => id),
      ['hello-agent'],
    );
    assert.match(result.stderr, /AVERTISSEMENT/);
    assert.match(result.stderr, /redirect|fetch failed/i);
    const requests = await registry.requests();
    const artifactRequests = requests.filter(({ url }) =>
      url.startsWith('/registry/'),
    );
    assert.equal(artifactRequests.at(-1)?.url, '/registry/catalog-index.json');
    assert.equal(
      artifactRequests.some(
        ({ url }) => url === '/registry/redirect-target.json',
      ),
      false,
    );
  });
});

test('outdated compares the lock against the resolved remote index without fetching artifacts', async () => {
  await withCache(async (cacheDirectory) => {
    const projectDirectory = await mkdtemp(
      path.join(tmpdir(), 'lufa-outdated-'),
    );
    try {
      const install = cli(
        [
          'install',
          'hello-agent@1.1.0',
          '--project',
          projectDirectory,
          '--yes',
        ],
        repoRoot,
        cacheDirectory,
      );
      assert.equal(install.status, 0, install.stderr);

      const remote = structuredClone(bundledIndex);
      remote.artifacts[0].versions[0].version = '9.0.0';
      remote.artifacts[0].versions[0].publishedAt = '2026-10-10T00:00:00Z';
      await registry.setResponse(remote);
      const outdated = cli(
        ['outdated', '--project', projectDirectory, '--json'],
        repoRoot,
        cacheDirectory,
      );
      assert.equal(outdated.status, 0, outdated.stderr);
      assert.equal(JSON.parse(outdated.stdout)[0].latestStable, '9.0.0');
      assert.match(outdated.stderr, /distant actualisé/);
    } finally {
      await rm(projectDirectory, { recursive: true, force: true });
    }
  });
});
