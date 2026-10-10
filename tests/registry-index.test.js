import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstat,
  link,
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

test('remote index requires lowercase 64-character SHA-256 values', async () => {
  await withCache(async (cacheDirectory) => {
    const invalid = structuredClone(bundledIndex);
    invalid.artifacts[0].versions[0].files[0].sha256 = 'A'.repeat(64);
    await registry.setResponse(invalid);
    const result = cli(['list', '--json'], repoRoot, cacheDirectory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /empreinte SHA-256 publiée/);
    assert.deepEqual(
      JSON.parse(result.stdout).map(({ id }) => id),
      ['hello-agent'],
    );
    await registry.setResponse(bundledIndex);
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

test('install fetches exact remote bytes, caches them, and reinstalls offline', async () => {
  await withCache(async (cacheDirectory) => {
    const version = bundledIndex.artifacts[0].versions.find(
      ({ version }) => version === '1.2.0',
    );
    const file = version.files[0];
    const projectA = await mkdtemp(path.join(tmpdir(), 'lufa-remote-install-'));
    const projectB = await mkdtemp(
      path.join(tmpdir(), 'lufa-offline-install-'),
    );
    try {
      await registry.setResponse(bundledIndex);
      const before = (await registry.requests()).length;
      const downloaded = cli(
        ['install', 'hello-agent@1.2.0', '--project', projectA, '--yes'],
        repoRoot,
        cacheDirectory,
      );
      assert.equal(downloaded.status, 0, downloaded.stderr);
      assert.match(downloaded.stderr, /Contenus exacts hello-agent@1\.2\.0/);
      const assetUrl = `/registry/catalog/hello-agent/${file.path
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`;
      await registry.setFileResponse(
        assetUrl,
        await readFile(
          new URL(`../catalog/hello-agent/${file.path}`, import.meta.url),
        ),
        200,
        { 'content-type': 'text/markdown; charset=utf-8' },
      );
      assert.ok(
        (await registry.requests())
          .slice(before)
          .some(({ method, url }) => method === 'GET' && url === assetUrl),
      );
      assert.ok(
        await lstat(
          path.join(
            cacheDirectory,
            'contents',
            'sha256',
            file.sha256.slice(0, 2),
            file.sha256,
          ),
        ),
      );

      const reinstalled = cli(
        ['install', 'hello-agent@1.2.0', '--project', projectA, '--yes'],
        repoRoot,
        cacheDirectory,
      );
      assert.equal(reinstalled.status, 0, reinstalled.stderr);
      assert.match(reinstalled.stdout, /Déjà installé/);

      await registry.setResponse({ unavailable: true }, 503);
      const requestCount = (await registry.requests()).length;
      const offline = cli(
        ['install', 'hello-agent@1.2.0', '--project', projectB, '--yes'],
        repoRoot,
        cacheDirectory,
      );
      assert.equal(offline.status, 0, offline.stderr);
      assert.match(offline.stderr, /potentiellement périmé/);
      assert.equal(
        await readFile(
          path.join(projectB, '.agents/skills/hello-agent/SKILL.md'),
          'utf8',
        ),
        await readFile(
          new URL(
            '../catalog/hello-agent/versions/1.2.0/SKILL.md',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      const newRequests = (await registry.requests()).slice(requestCount);
      assert.equal(
        newRequests.some(({ url }) => url.startsWith('/registry/catalog/')),
        false,
      );
    } finally {
      await rm(projectA, { recursive: true, force: true });
      await rm(projectB, { recursive: true, force: true });
      await registry.setResponse(bundledIndex);
    }
  });
});

test('bad checksum and failed/unsafe artifact responses leave project and lock unchanged', async () => {
  const originalIndex = structuredClone(bundledIndex);
  const artifact = originalIndex.artifacts[0];
  const version = artifact.versions.find(({ version }) => version === '1.2.0');
  const file = version.files[0];
  const assetUrl = `/registry/catalog/hello-agent/${file.path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  const fileBytes = await readFile(
    new URL(`../catalog/hello-agent/${file.path}`, import.meta.url),
  );

  async function assertNoProjectMutation(
    index,
    status,
    headers = {},
    body = fileBytes,
    delayMs = 0,
    expected,
  ) {
    await withCache(async (cacheDirectory) => {
      const project = await mkdtemp(
        path.join(tmpdir(), 'lufa-download-failure-'),
      );
      try {
        const lockContents = '{"schemaVersion":1,"installs":[]}\n';
        await writeFile(path.join(project, 'lufa.lock.json'), lockContents);
        await writeFile(path.join(project, 'keep.txt'), 'unchanged');
        await registry.setResponse(index);
        await registry.setFileResponse(
          assetUrl,
          body,
          status,
          { 'content-type': 'application/octet-stream', ...headers },
          delayMs,
        );
        const result = cli(
          ['install', 'hello-agent@1.2.0', '--project', project, '--yes'],
          repoRoot,
          cacheDirectory,
        );
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, expected);
        assert.equal(
          await readFile(path.join(project, 'lufa.lock.json'), 'utf8'),
          lockContents,
        );
        assert.equal(
          await readFile(path.join(project, 'keep.txt'), 'utf8'),
          'unchanged',
        );
        await assert.rejects(lstat(path.join(project, '.agents')));
      } finally {
        await rm(project, { recursive: true, force: true });
      }
    });
  }

  try {
    const mismatched = structuredClone(originalIndex);
    mismatched.artifacts[0].versions.find(
      ({ version }) => version === '1.2.0',
    ).files[0].sha256 = 'a'.repeat(64);
    await assertNoProjectMutation(
      mismatched,
      200,
      {},
      fileBytes,
      0,
      /Checksum SHA-256 invalide/,
    );
    await assertNoProjectMutation(
      originalIndex,
      200,
      { 'content-type': 'text/html; charset=utf-8' },
      fileBytes,
      0,
      /Content-Type refusé/,
    );
    await assertNoProjectMutation(
      originalIndex,
      404,
      {},
      'Not found',
      0,
      /HTTP 404/,
    );
    await assertNoProjectMutation(
      originalIndex,
      302,
      { location: '/elsewhere' },
      '',
      0,
      /redirection refusée|fetch failed/i,
    );
    await assertNoProjectMutation(
      originalIndex,
      200,
      { 'content-length': String(2 * 1024 * 1024 + 1) },
      Buffer.alloc(2 * 1024 * 1024 + 1),
      0,
      /trop volumineux/,
    );
    await assertNoProjectMutation(
      originalIndex,
      200,
      {},
      fileBytes,
      3_500,
      /délai dépassé/,
    );
  } finally {
    await registry.setResponse(bundledIndex);
    await registry.setFileResponse(assetUrl, fileBytes, 200, {
      'content-type': 'application/octet-stream',
    });
  }
});

test('a second-file checksum failure writes no first-file blob to cache', async () => {
  await withCache(async (cacheDirectory) => {
    const index = structuredClone(bundledIndex);
    const version = index.artifacts[0].versions.find(
      ({ version }) => version === '1.2.0',
    );
    assert.equal(version.files.length, 2);
    const first = version.files[0];
    const second = version.files[1];
    const secondExpectedSha256 = second.sha256;
    second.sha256 = 'e'.repeat(64);
    const project = await mkdtemp(path.join(tmpdir(), 'lufa-atomic-blobs-'));
    const lockContents = '{"schemaVersion":1,"installs":[]}\n';
    const firstBytes = await readFile(
      new URL(`../catalog/hello-agent/${first.path}`, import.meta.url),
    );
    const blobPath = (sha256) =>
      path.join(
        cacheDirectory,
        'contents',
        'sha256',
        sha256.slice(0, 2),
        sha256,
      );
    try {
      await writeFile(path.join(project, 'lufa.lock.json'), lockContents);
      await registry.setResponse(index);
      for (const file of [first, second]) {
        const relativeUrl = `/registry/catalog/hello-agent/${file.path
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`;
        await registry.setFileResponse(
          relativeUrl,
          file.path === first.path
            ? firstBytes
            : await readFile(
                new URL(`../catalog/hello-agent/${file.path}`, import.meta.url),
              ),
          200,
          { 'content-type': 'application/octet-stream' },
        );
      }

      const result = cli(
        ['install', 'hello-agent@1.2.0', '--project', project, '--yes'],
        repoRoot,
        cacheDirectory,
      );
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Checksum SHA-256 invalide/);
      assert.equal(
        await readFile(path.join(project, 'lufa.lock.json'), 'utf8'),
        lockContents,
      );
      await assert.rejects(lstat(path.join(project, '.agents')));
      await assert.rejects(lstat(blobPath(first.sha256)));
      assert.notEqual(first.sha256, secondExpectedSha256);

      const preserveCache = path.join(cacheDirectory, 'preexisting-cache');
      const preserveProject = await mkdtemp(
        path.join(tmpdir(), 'lufa-preserve-blob-'),
      );
      const existingBlob = blobPath(first.sha256).replace(
        cacheDirectory,
        preserveCache,
      );
      try {
        await mkdir(path.dirname(existingBlob), { recursive: true });
        await writeFile(existingBlob, firstBytes);
        await writeFile(
          path.join(preserveProject, 'lufa.lock.json'),
          lockContents,
        );
        const preserveResult = cli(
          [
            'install',
            'hello-agent@1.2.0',
            '--project',
            preserveProject,
            '--yes',
          ],
          repoRoot,
          preserveCache,
        );
        assert.equal(preserveResult.status, 1, preserveResult.stderr);
        assert.match(preserveResult.stderr, /Checksum SHA-256 invalide/);
        assert.deepEqual(await readFile(existingBlob), firstBytes);
        assert.equal(
          await readFile(path.join(preserveProject, 'lufa.lock.json'), 'utf8'),
          lockContents,
        );
        await assert.rejects(lstat(path.join(preserveProject, '.agents')));
      } finally {
        await rm(preserveProject, { recursive: true, force: true });
      }
    } finally {
      await rm(project, { recursive: true, force: true });
      await registry.setResponse(bundledIndex);
      for (const file of [first, second]) {
        const relativeUrl = `/registry/catalog/hello-agent/${file.path
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`;
        await registry.setFileResponse(
          relativeUrl,
          await readFile(
            new URL(`../catalog/hello-agent/${file.path}`, import.meta.url),
          ),
          200,
          { 'content-type': 'application/octet-stream' },
        );
      }
    }
  });
});

test('offline install without an exact index or cached file fails with recovery guidance', async () => {
  await withCache(async (cacheDirectory) => {
    const remoteOnly = structuredClone(bundledIndex);
    remoteOnly.artifacts[0].id = 'remote-only';
    await registry.setResponse(remoteOnly);
    const outage = await registry.setResponse({ unavailable: true }, 503);
    void outage;
    const project = await mkdtemp(
      path.join(tmpdir(), 'lufa-no-offline-content-'),
    );
    try {
      const result = cli(
        ['install', 'remote-only', '--project', project, '--yes'],
        repoRoot,
        cacheDirectory,
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /reconnectez-vous au registre/);
      await assert.rejects(lstat(path.join(project, 'lufa.lock.json')));
    } finally {
      await rm(project, { recursive: true, force: true });
      await registry.setResponse(bundledIndex);
    }
  });
});

test('content cache refuses hardlinked and hash-corrupted blobs before project writes', async () => {
  await withCache(async (cacheDirectory) => {
    const version = bundledIndex.artifacts[0].versions.find(
      ({ version }) => version === '1.2.0',
    );
    const file = version.files[0];
    const blob = path.join(
      cacheDirectory,
      'contents',
      'sha256',
      file.sha256.slice(0, 2),
      file.sha256,
    );
    const seedProject = await mkdtemp(path.join(tmpdir(), 'lufa-blob-seed-'));
    const unsafeProject = await mkdtemp(
      path.join(tmpdir(), 'lufa-blob-unsafe-'),
    );
    const linkedBlob = path.join(cacheDirectory, 'linked-blob');
    try {
      await registry.setResponse(bundledIndex);
      const seed = cli(
        ['install', 'hello-agent@1.2.0', '--project', seedProject, '--yes'],
        repoRoot,
        cacheDirectory,
      );
      assert.equal(seed.status, 0, seed.stderr);
      await link(blob, linkedBlob);
      const linked = cli(
        ['install', 'hello-agent@1.2.0', '--project', unsafeProject, '--yes'],
        repoRoot,
        cacheDirectory,
      );
      assert.equal(linked.status, 1);
      assert.match(linked.stderr, /fichier de cache.*isolé/);
      await rm(linkedBlob);

      await writeFile(blob, 'corrupted cache bytes');
      const corrupted = cli(
        ['install', 'hello-agent@1.2.0', '--project', unsafeProject, '--yes'],
        repoRoot,
        cacheDirectory,
      );
      assert.equal(corrupted.status, 1);
      assert.match(corrupted.stderr, /Contenu corrompu dans le cache/);
      await assert.rejects(lstat(path.join(unsafeProject, '.agents')));
      await assert.rejects(lstat(path.join(unsafeProject, 'lufa.lock.json')));
    } finally {
      await rm(seedProject, { recursive: true, force: true });
      await rm(unsafeProject, { recursive: true, force: true });
      await registry.setResponse(bundledIndex);
    }
  });
});
