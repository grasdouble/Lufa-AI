import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runInstallCommand } from '../src/install-command.ts';

const cliPath = fileURLToPath(
  new URL('../src/lufa-command.ts', import.meta.url),
);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function withFixture(callback, versions = ['1.0.0']) {
  const root = await mkdtemp(path.join(tmpdir(), 'lufa-install-test-'));
  const catalogRoot = path.join(root, 'source');
  const projectRoot = path.join(root, 'consumer');
  const artifactRoot = path.join(catalogRoot, 'catalog', 'sample');
  await mkdir(artifactRoot, { recursive: true });
  await mkdir(projectRoot);
  const artifact = {
    id: 'sample',
    name: 'Sample',
    description: 'Install test skill.',
    type: 'skill',
    authors: ['Test author'],
    provenance: { repository: 'https://example.com/sample', license: 'MIT' },
    discovery: { categories: [], keywords: [] },
    versions: versions.map((version, index) => ({
      version,
      publishedAt: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
      files: [
        {
          path: `versions/${version}/SKILL.md`,
          destination: '.agents/skills/sample/SKILL.md',
        },
      ],
      compatibilities: [{ environment: 'example-agent', level: 'declared' }],
      prerequisites: [],
      warnings: [],
    })),
  };
  await writeFile(
    path.join(artifactRoot, 'artifact.json'),
    JSON.stringify(artifact),
  );
  for (const version of versions) {
    const contents = `# Sample ${version}\n`;
    const source = path.join(artifactRoot, 'versions', version, 'SKILL.md');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, contents);
  }

  const logs = [];
  const originalLog = console.log;
  console.log = (...values) => logs.push(values.join(' '));
  try {
    await callback({
      root,
      catalogRoot,
      projectRoot,
      artifactRoot,
      artifact,
      logs,
    });
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
}

function install(context, args = ['sample'], options = {}) {
  return runInstallCommand(args, {
    project: context.projectRoot,
    catalogRoot: context.catalogRoot,
    interactive: true,
    confirm: async () => true,
    ...options,
  });
}

test('install chooses the newest stable release and records source, target, paths and SHA-256', async () => {
  await withFixture(
    async (context) => {
      await install(context);
      const installed = await readFile(
        path.join(context.projectRoot, '.agents/skills/sample/SKILL.md'),
        'utf8',
      );
      assert.equal(installed, '# Sample 1.2.0\n');
      const lock = JSON.parse(
        await readFile(
          path.join(context.projectRoot, 'lufa.lock.json'),
          'utf8',
        ),
      );
      assert.deepEqual(lock, {
        schemaVersion: 1,
        installs: [
          {
            id: 'sample',
            version: '1.2.0',
            target: '.agents/skills',
            source: 'https://example.com/sample',
            files: [
              {
                path: '.agents/skills/sample/SKILL.md',
                sha256: createHash('sha256')
                  .update('# Sample 1.2.0\n')
                  .digest('hex'),
              },
            ],
          },
        ],
      });
      assert.match(context.logs.join('\n'), /https:\/\/example\.com\/sample/);
      assert.match(context.logs.join('\n'), /sample@1\.2\.0/);
      assert.match(context.logs.join('\n'), /Fichiers prévus/);
    },
    ['1.2.0-rc.1', '1.0.0', '1.2.0', '1.1.0'],
  );
});

test('an explicit version selects exactly that version, including an explicit prerelease', async () => {
  await withFixture(
    async (context) => {
      await install(context, ['sample@1.2.0-rc.1']);
      assert.equal(
        await readFile(
          path.join(context.projectRoot, '.agents/skills/sample/SKILL.md'),
          'utf8',
        ),
        '# Sample 1.2.0-rc.1\n',
      );
      const lock = JSON.parse(
        await readFile(
          path.join(context.projectRoot, 'lufa.lock.json'),
          'utf8',
        ),
      );
      assert.equal(lock.installs[0].version, '1.2.0-rc.1');
    },
    ['1.2.0-rc.1', '1.2.0', '1.0.0'],
  );
});

test('confirmation is required, previews files, and a declined confirmation changes nothing', async () => {
  await withFixture(async (context) => {
    let prompted = false;
    await install(context, ['sample'], {
      confirm: async () => {
        prompted = true;
        return false;
      },
    });
    assert.equal(prompted, true);
    assert.match(context.logs.join('\n'), /Fichiers prévus/);
    await assert.rejects(
      lstat(path.join(context.projectRoot, 'lufa.lock.json')),
    );
    await assert.rejects(lstat(path.join(context.projectRoot, '.agents')));
  });
});

test('CLI requires an explicit non-interactive confirmation and --yes installs in --project', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'lufa-cli-install-'));
  try {
    const noConfirmation = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cliPath,
        'install',
        'hello-agent',
        '--project',
        project,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    assert.equal(noConfirmation.status, 1);
    assert.match(noConfirmation.stderr, /confirmer explicitement avec --yes/);
    assert.deepEqual(
      await (await import('node:fs/promises')).readdir(project),
      [],
    );

    const confirmed = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cliPath,
        'install',
        'hello-agent',
        '--project',
        project,
        '--yes',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    assert.equal(confirmed.status, 0, confirmed.stderr);
    assert.match(
      confirmed.stdout,
      /Source : .*catalogue local de développement/,
    );
    assert.match(confirmed.stdout, /Version : hello-agent@1\.0\.0/);
    assert.match(confirmed.stdout, /Destination :/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('reinstalling intact locked files is idempotent; modified files are never overwritten', async () => {
  await withFixture(async (context) => {
    await install(context);
    const lockBefore = await readFile(
      path.join(context.projectRoot, 'lufa.lock.json'),
      'utf8',
    );
    await install(context);
    assert.match(context.logs.at(-1), /Déjà installé/);
    assert.equal(
      await readFile(path.join(context.projectRoot, 'lufa.lock.json'), 'utf8'),
      lockBefore,
    );

    const destination = path.join(
      context.projectRoot,
      '.agents/skills/sample/SKILL.md',
    );
    await writeFile(destination, 'user edit');
    await assert.rejects(install(context), /modifié ou supprimé/);
    assert.equal(await readFile(destination, 'utf8'), 'user edit');
  });
});

test('concurrent installs serialize on one project and preserve both lock entries', async () => {
  await withFixture(async (context) => {
    const otherArtifact = structuredClone(context.artifact);
    otherArtifact.id = 'other';
    otherArtifact.name = 'Other';
    otherArtifact.provenance.repository = 'https://example.com/other';
    otherArtifact.versions[0].files[0].destination =
      '.agents/skills/other/SKILL.md';
    const otherRoot = path.join(context.catalogRoot, 'catalog', 'other');
    await mkdir(path.join(otherRoot, 'versions/1.0.0'), { recursive: true });
    await writeFile(
      path.join(otherRoot, 'artifact.json'),
      JSON.stringify(otherArtifact),
    );
    await writeFile(
      path.join(otherRoot, 'versions/1.0.0/SKILL.md'),
      '# Other\n',
    );

    // Hold the project lock until both commands have deterministically reached
    // the contention path, then let their exclusive-create arbitration proceed.
    const gate = path.join(context.projectRoot, '.lufa.install.lock');
    await writeFile(gate, 'test gate');
    let waiters = 0;
    let releaseBarrier;
    const bothWaiting = new Promise((resolve) => {
      releaseBarrier = resolve;
    });
    const onProjectLockWait = () => {
      waiters += 1;
      if (waiters === 2) releaseBarrier();
    };
    const first = install(context, ['sample', '--yes'], { onProjectLockWait });
    const second = install(context, ['other', '--yes'], { onProjectLockWait });
    await bothWaiting;
    await rm(gate);
    await Promise.all([first, second]);

    assert.equal(
      await readFile(
        path.join(context.projectRoot, '.agents/skills/sample/SKILL.md'),
        'utf8',
      ),
      '# Sample 1.0.0\n',
    );
    assert.equal(
      await readFile(
        path.join(context.projectRoot, '.agents/skills/other/SKILL.md'),
        'utf8',
      ),
      '# Other\n',
    );
    const lock = JSON.parse(
      await readFile(path.join(context.projectRoot, 'lufa.lock.json'), 'utf8'),
    );
    assert.deepEqual(
      lock.installs.map(({ id }) => id),
      ['other', 'sample'],
    );
  });
});

test('existing unmanaged destinations and different locked versions are safe conflicts', async () => {
  await withFixture(async (context) => {
    const destination = path.join(
      context.projectRoot,
      '.agents/skills/sample/SKILL.md',
    );
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, 'user file');
    await assert.rejects(install(context), /existe déjà et n’est pas géré/);
    assert.equal(await readFile(destination, 'utf8'), 'user file');
    await assert.rejects(
      lstat(path.join(context.projectRoot, 'lufa.lock.json')),
    );
  });

  await withFixture(
    async (context) => {
      await install(context);
      await assert.rejects(
        install(context, ['sample@0.9.0']),
        /déjà verrouillé différemment/,
      );
    },
    ['1.0.0', '0.9.0'],
  );
});

test('catalog traversal and destination/source symlinks are rejected', async () => {
  await withFixture(async (context) => {
    context.artifact.versions[0].files[0].destination = '../outside/SKILL.md';
    await writeFile(
      path.join(context.artifactRoot, 'artifact.json'),
      JSON.stringify(context.artifact),
    );
    await assert.rejects(install(context), /chemin relatif dangereux/);
    await assert.rejects(
      lstat(path.join(context.projectRoot, 'lufa.lock.json')),
    );
  });

  await withFixture(async (context) => {
    const skillDirectory = path.join(context.projectRoot, '.agents/skills');
    await mkdir(path.dirname(skillDirectory), { recursive: true });
    await symlink(context.root, skillDirectory);
    await assert.rejects(install(context), /Lien symbolique interdit/);
  });

  await withFixture(async (context) => {
    const source = path.join(context.artifactRoot, 'versions/1.0.0/SKILL.md');
    await rm(source);
    const alternate = path.join(context.artifactRoot, 'alternate.md');
    await writeFile(alternate, 'unsafe');
    await symlink(alternate, source);
    await assert.rejects(install(context), /Source symbolique interdite/);
  });
});

test('anchored CWD rejects a parent replaced by a symlink before the relative write', async () => {
  await withFixture(async (context) => {
    const originalCwd = process.cwd();
    const outside = path.join(context.root, 'outside');
    const skillsDirectory = path.join(context.projectRoot, '.agents/skills');
    const movedSkillsDirectory = path.join(
      context.projectRoot,
      '.agents/skills-original',
    );
    await mkdir(outside);

    await assert.rejects(
      install(context, ['sample', '--yes'], {
        onAfterCwdCheckBeforeWrite: async () => {
          // Replace the checked parent precisely after its last validation and
          // immediately before basename-relative staging/link operations.
          await rename(skillsDirectory, movedSkillsDirectory);
          await symlink(outside, skillsDirectory);
        },
      }),
      /répertoire de travail ancré a changé/,
    );
    assert.deepEqual(await readdir(outside), []);
    assert.deepEqual(await readdir(path.dirname(movedSkillsDirectory)), [
      'skills',
    ]);
    await assert.rejects(
      lstat(path.join(context.projectRoot, 'lufa.lock.json')),
    );
    assert.equal(process.cwd(), originalCwd);
  });
});

test('rollback removes earlier transaction files when the anchored directory is renamed within the project', async () => {
  await withFixture(async (context) => {
    const originalCwd = process.cwd();
    const version = context.artifact.versions[0];
    version.files = [
      {
        path: 'versions/1.0.0/A.md',
        destination: '.agents/skills/sample/A.md',
      },
      {
        path: 'versions/1.0.0/B.md',
        destination: '.agents/skills/sample/B.md',
      },
    ];
    await writeFile(
      path.join(context.artifactRoot, 'artifact.json'),
      JSON.stringify(context.artifact),
    );
    await writeFile(
      path.join(context.artifactRoot, 'versions/1.0.0/A.md'),
      'A',
    );
    await writeFile(
      path.join(context.artifactRoot, 'versions/1.0.0/B.md'),
      'B',
    );

    const outside = path.join(context.root, 'outside');
    const skillsDirectory = path.join(context.projectRoot, '.agents/skills');
    const movedSkillsDirectory = path.join(
      context.projectRoot,
      '.agents/skills-moved',
    );
    await mkdir(outside);

    await assert.rejects(
      install(context, ['sample', '--yes'], {
        onAfterCwdCheckBeforeWrite: async (destination) => {
          if (destination.endsWith('/B.md')) {
            assert.equal(
              await readFile(path.join(skillsDirectory, 'sample/A.md'), 'utf8'),
              'A',
            );
            await rename(skillsDirectory, movedSkillsDirectory);
            await symlink(outside, skillsDirectory);
          }
        },
      }),
      /Échec de l’installation/,
    );

    assert.deepEqual(await readdir(outside), []);
    await assert.rejects(lstat(movedSkillsDirectory));
    await assert.rejects(
      lstat(path.join(context.projectRoot, 'lufa.lock.json')),
    );
    assert.equal(process.cwd(), originalCwd);
  });
});

test('rollback refuses unsafe cleanup when the anchored directory was moved outside the project', async () => {
  await withFixture(async (context) => {
    const version = context.artifact.versions[0];
    version.files = [
      {
        path: 'versions/1.0.0/A.md',
        destination: '.agents/skills/sample/A.md',
      },
      {
        path: 'versions/1.0.0/B.md',
        destination: '.agents/skills/sample/B.md',
      },
    ];
    await writeFile(
      path.join(context.artifactRoot, 'artifact.json'),
      JSON.stringify(context.artifact),
    );
    await writeFile(
      path.join(context.artifactRoot, 'versions/1.0.0/A.md'),
      'A',
    );
    await writeFile(
      path.join(context.artifactRoot, 'versions/1.0.0/B.md'),
      'B',
    );

    const skillsDirectory = path.join(context.projectRoot, '.agents/skills');
    const outsideTarget = path.join(context.root, 'outside-target');
    const movedSkillsDirectory = path.join(context.root, 'moved-skills');
    await mkdir(outsideTarget);
    let reportedError = '';
    await assert.rejects(
      install(context, ['sample', '--yes'], {
        onAfterCwdCheckBeforeWrite: async (destination) => {
          if (destination.endsWith('/B.md')) {
            await rename(skillsDirectory, movedSkillsDirectory);
            await symlink(outsideTarget, skillsDirectory);
          }
        },
      }),
      (error) => {
        reportedError = error.message;
        return /Rollback incomplet : 1 fichier/.test(error.message);
      },
    );

    assert.match(reportedError, /n’est plus identifiable sous le projet/);
    assert.equal(
      await readFile(path.join(movedSkillsDirectory, 'sample/A.md'), 'utf8'),
      'A',
    );
    await assert.rejects(lstat(path.join(movedSkillsDirectory, 'sample/B.md')));
    assert.deepEqual(await readdir(outsideTarget), []);
    await assert.rejects(
      lstat(path.join(context.projectRoot, 'lufa.lock.json')),
    );
  });
});

test('a write failure after one file rolls back installed files and does not write a lock', async () => {
  await withFixture(async (context) => {
    const version = context.artifact.versions[0];
    version.files.push({
      path: 'versions/1.0.0/EXTRA.md',
      destination: '.agents/skills/sample/EXTRA.md',
    });
    await writeFile(
      path.join(context.artifactRoot, 'artifact.json'),
      JSON.stringify(context.artifact),
    );
    await writeFile(
      path.join(context.artifactRoot, 'versions/1.0.0/EXTRA.md'),
      'second file',
    );
    await assert.rejects(
      install(context, ['sample'], {
        confirm: async () => {
          const second = path.join(
            context.projectRoot,
            '.agents/skills/sample/EXTRA.md',
          );
          await mkdir(path.dirname(second), { recursive: true });
          await writeFile(second, 'created concurrently');
          return true;
        },
      }),
      /Échec de l’installation/,
    );
    await assert.rejects(
      lstat(path.join(context.projectRoot, '.agents/skills/sample/SKILL.md')),
    );
    assert.equal(
      await readFile(
        path.join(context.projectRoot, '.agents/skills/sample/EXTRA.md'),
        'utf8',
      ),
      'created concurrently',
    );
    await assert.rejects(
      lstat(path.join(context.projectRoot, 'lufa.lock.json')),
    );
  });
});
