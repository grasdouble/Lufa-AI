import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildCatalogIndex,
  CatalogValidationError,
  loadCatalog,
} from '../src/catalog.ts';

const fixtureVersion = {
  version: '1.2.3',
  publishedAt: '2026-10-10T00:00:00Z',
  files: [
    {
      path: 'versions/1.2.3/SKILL.md',
      destination: '.agents/skills/sample/SKILL.md',
    },
  ],
  compatibilities: [{ environment: 'example-agent', level: 'declared' }],
  prerequisites: [],
  warnings: [],
};

async function withCatalog(artifacts, callback) {
  const root = await mkdtemp(path.join(tmpdir(), 'lufa-catalog-test-'));
  try {
    for (const { directory, artifact, files = [] } of artifacts) {
      const artifactDirectory = path.join(root, 'catalog', directory);
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(
        path.join(artifactDirectory, 'artifact.json'),
        JSON.stringify(artifact),
      );
      for (const [relativePath, contents] of files) {
        const filePath = path.join(artifactDirectory, relativePath);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, contents);
      }
    }
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function artifact(overrides = {}) {
  return {
    id: 'sample',
    name: 'Sample',
    description: 'A test skill.',
    type: 'skill',
    authors: ['Test author'],
    provenance: { repository: 'https://example.com/source', license: 'MIT' },
    discovery: { categories: ['testing'], keywords: ['sample'] },
    versions: [{ ...fixtureVersion }],
    ...overrides,
  };
}

test('pilot artifact validates while keeping artifact type and target environments separate', async () => {
  const artifacts = await loadCatalog();
  const pilot = artifacts.find((item) => item.id === 'hello-agent');

  assert.ok(pilot);
  assert.equal(pilot.type, 'skill');
  assert.deepEqual(
    pilot.versions[0].compatibilities.map(({ environment, level }) => ({
      environment,
      level,
    })),
    [
      { environment: 'github-copilot', level: 'declared' },
      { environment: 'opencode', level: 'declared' },
    ],
  );
});

test('catalog index is deterministic and matches the committed generated index', async () => {
  const [first, second, committed] = await Promise.all([
    buildCatalogIndex(),
    buildCatalogIndex(),
    readFile(
      new URL('../generated/catalog-index.json', import.meta.url),
      'utf8',
    ),
  ]);

  assert.equal(first, second);
  assert.equal(first, committed);
});

test('rejects missing required fields', async () => {
  const invalid = artifact();
  delete invalid.description;

  await withCatalog(
    [
      {
        directory: 'sample',
        artifact: invalid,
        files: [['versions/1.2.3/SKILL.md', '# Sample']],
      },
    ],
    async (root) =>
      assert.rejects(loadCatalog(root), /required property 'description'/i),
  );
});

test('rejects duplicate artifact identifiers', async () => {
  await withCatalog(
    [
      {
        directory: 'sample',
        artifact: artifact(),
        files: [['versions/1.2.3/SKILL.md', '# Sample']],
      },
      {
        directory: 'sample-copy',
        artifact: artifact(),
        files: [['versions/1.2.3/SKILL.md', '# Copy']],
      },
    ],
    async (root) => assert.rejects(loadCatalog(root), /identifiant.*dupliqué/i),
  );
});

test('rejects duplicate versions', async () => {
  const invalid = artifact({
    versions: [{ ...fixtureVersion }, { ...fixtureVersion }],
  });

  await withCatalog(
    [
      {
        directory: 'sample',
        artifact: invalid,
        files: [['versions/1.2.3/SKILL.md', '# Sample']],
      },
    ],
    async (root) => assert.rejects(loadCatalog(root), /version dupliquée/i),
  );
});

test('rejects invalid SemVer versions', async () => {
  const invalid = artifact({
    versions: [{ ...fixtureVersion, version: '01.2.3' }],
  });

  await withCatalog(
    [
      {
        directory: 'sample',
        artifact: invalid,
        files: [['versions/1.2.3/SKILL.md', '# Sample']],
      },
    ],
    async (root) => assert.rejects(loadCatalog(root), /SemVer stricte/i),
  );
});

test('accepts real UTC calendar dates and rejects impossible date-times', async () => {
  for (const publishedAt of [
    '2026-10-10T00:00:00Z',
    '2024-02-29T23:59:59.123456Z',
  ]) {
    const valid = artifact({
      versions: [{ ...fixtureVersion, publishedAt }],
    });
    await withCatalog(
      [
        {
          directory: 'sample',
          artifact: valid,
          files: [['versions/1.2.3/SKILL.md', '# Sample']],
        },
      ],
      async (root) => assert.equal((await loadCatalog(root)).length, 1),
    );
  }

  for (const publishedAt of [
    '2026-99-99T25:61:61Z',
    '2026-02-29T12:00:00Z',
    '2024-04-31T12:00:00Z',
    '2026-10-10T24:00:00Z',
  ]) {
    const invalid = artifact({
      versions: [{ ...fixtureVersion, publishedAt }],
    });
    await withCatalog(
      [{ directory: 'sample', artifact: invalid }],
      async (root) =>
        assert.rejects(loadCatalog(root), /date de publication invalide/i),
    );
  }
});

test('rejects blank verified evidence but accepts documented proof values', async () => {
  const compatibility = {
    environment: 'example-agent',
    level: 'verified',
    evidence: {
      testedVersion: ' ',
      method: ' ',
      reference: ' ',
    },
  };
  const invalid = artifact({
    versions: [
      {
        ...fixtureVersion,
        compatibilities: [compatibility],
      },
    ],
  });

  await withCatalog(
    [{ directory: 'sample', artifact: invalid }],
    async (root) => assert.rejects(loadCatalog(root), /must match pattern/i),
  );

  const valid = artifact({
    versions: [
      {
        ...fixtureVersion,
        compatibilities: [
          {
            ...compatibility,
            evidence: {
              testedVersion: '1.2.3',
              method: 'Manual CLI smoke test',
              reference: 'https://example.test/evidence',
            },
          },
        ],
      },
    ],
  });
  await withCatalog(
    [
      {
        directory: 'sample',
        artifact: valid,
        files: [['versions/1.2.3/SKILL.md', '# Sample']],
      },
    ],
    async (root) => assert.equal((await loadCatalog(root)).length, 1),
  );
});

test('rejects incorrect discovery metadata and unsubstantiated verified compatibility', async () => {
  const invalidMetadata = artifact({
    discovery: { categories: 'writing', keywords: ['sample'] },
  });
  const invalidProof = artifact({
    versions: [
      {
        ...fixtureVersion,
        compatibilities: [{ environment: 'example-agent', level: 'verified' }],
      },
    ],
  });

  await withCatalog(
    [
      {
        directory: 'sample',
        artifact: invalidMetadata,
        files: [['versions/1.2.3/SKILL.md', '# Sample']],
      },
    ],
    async (root) =>
      assert.rejects(
        loadCatalog(root),
        /discovery\/categories.*must be array/i,
      ),
  );
  await withCatalog(
    [
      {
        directory: 'sample',
        artifact: invalidProof,
        files: [['versions/1.2.3/SKILL.md', '# Sample']],
      },
    ],
    async (root) =>
      assert.rejects(loadCatalog(root), /required property 'evidence'/i),
  );
});

test('rejects source paths that leave the artifact package', async () => {
  const invalid = artifact({
    versions: [
      {
        ...fixtureVersion,
        files: [{ ...fixtureVersion.files[0], path: '../outside.txt' }],
      },
    ],
  });

  await withCatalog(
    [{ directory: 'sample', artifact: invalid }],
    async (root) => {
      await assert.rejects(loadCatalog(root), (error) => {
        assert.ok(error instanceof CatalogValidationError);
        assert.match(error.message, /chemin relatif dangereux/);
        return true;
      });
    },
  );
});

test('rejects absolute, Windows, and symlink paths escaping the artifact package', async () => {
  for (const unsafePath of [
    '/tmp/outside.txt',
    'C:/outside.txt',
    'versions\\outside.txt',
  ]) {
    const invalid = artifact({
      versions: [
        {
          ...fixtureVersion,
          files: [{ ...fixtureVersion.files[0], path: unsafePath }],
        },
      ],
    });
    await withCatalog(
      [{ directory: 'sample', artifact: invalid }],
      async (root) => {
        await assert.rejects(loadCatalog(root), /chemin relatif dangereux/);
      },
    );
  }

  await withCatalog(
    [
      {
        directory: 'sample',
        artifact: artifact(),
        files: [['versions/1.2.3/SKILL.md', '# Sample']],
      },
    ],
    async (root) => {
      const artifactDirectory = path.join(root, 'catalog', 'sample');
      const outside = path.join(root, 'outside.txt');
      await writeFile(outside, 'outside');
      await rm(path.join(artifactDirectory, 'versions/1.2.3/SKILL.md'));
      await symlink(
        outside,
        path.join(artifactDirectory, 'versions/1.2.3/SKILL.md'),
      );
      await assert.rejects(loadCatalog(root), /sort du paquet/i);
    },
  );
});

test('rejects missing source files', async () => {
  await withCatalog(
    [{ directory: 'sample', artifact: artifact() }],
    async (root) => {
      await assert.rejects(
        loadCatalog(root),
        /fichier absent ou sortant du paquet/i,
      );
    },
  );
});

test('rejects a catalog root symlink that points outside the repository', async () => {
  await withCatalog(
    [
      {
        directory: 'sample',
        artifact: artifact(),
        files: [['versions/1.2.3/SKILL.md', '# Sample']],
      },
    ],
    async (root) => {
      const catalogPath = path.join(root, 'catalog');
      const outsidePath = path.join(
        path.dirname(root),
        `${path.basename(root)}-catalog-outside`,
      );
      await rename(catalogPath, outsidePath);
      try {
        await symlink(
          outsidePath,
          catalogPath,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        await assert.rejects(
          loadCatalog(root),
          /racine du catalogue.*lien symbolique/i,
        );
      } finally {
        await rm(outsidePath, { recursive: true, force: true });
      }
    },
  );
});

test('rejects a symlinked artifact directory instead of silently omitting it', async () => {
  await withCatalog(
    [
      {
        directory: 'sample',
        artifact: artifact(),
        files: [['versions/1.2.3/SKILL.md', '# Sample']],
      },
    ],
    async (root) => {
      const hiddenArtifact = path.join(root, 'hidden-artifact');
      await mkdir(hiddenArtifact);
      await writeFile(
        path.join(hiddenArtifact, 'artifact.json'),
        JSON.stringify(artifact({ id: 'hidden-artifact' })),
      );
      await symlink(
        hiddenArtifact,
        path.join(root, 'catalog', 'hidden-artifact'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      await assert.rejects(
        loadCatalog(root),
        /entrée catalogue symbolique interdite.*hidden-artifact/i,
      );
    },
  );
});

test('orders accentuated and ASCII paths by Unicode code point, independent of locale', async () => {
  const sourcePaths = ['é.md', 'z.md', 'a.md'];
  const sortedArtifact = artifact({
    versions: [
      {
        ...fixtureVersion,
        files: sourcePaths.map((sourcePath) => ({
          path: sourcePath,
          destination: `.agents/skills/sample/${sourcePath}`,
        })),
      },
    ],
  });

  await withCatalog(
    [
      {
        directory: 'sample',
        artifact: sortedArtifact,
        files: sourcePaths.map((sourcePath) => [sourcePath, `# ${sourcePath}`]),
      },
    ],
    async (root) => {
      const index = JSON.parse(await buildCatalogIndex(root));
      assert.deepEqual(
        index.artifacts[0].versions[0].files.map((file) => file.path),
        ['a.md', 'z.md', 'é.md'],
      );
      assert.equal(
        await buildCatalogIndex(root),
        await buildCatalogIndex(root),
      );
    },
  );
});
