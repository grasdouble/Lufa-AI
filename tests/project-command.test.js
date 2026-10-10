import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { runInstallCommand } from '../src/install-command.ts';
import { runUpdateCommand } from '../src/project-command.ts';
import { createRegistryFixture } from './registry-fixture.js';

const cliPath = fileURLToPath(
  new URL('../src/lufa-command.ts', import.meta.url),
);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const registry = await createRegistryFixture();
const cacheDirectory = await mkdtemp(
  path.join(tmpdir(), 'lufa-project-cache-'),
);

after(async () => {
  await registry.close();
  await rm(cacheDirectory, { recursive: true, force: true });
});

function cli(args, cwd = repoRoot) {
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
    },
  );
}

async function withProject(callback) {
  const project = await mkdtemp(path.join(tmpdir(), 'lufa-project-test-'));
  try {
    await callback(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

function install(project, version = '1.1.0') {
  const result = cli([
    'install',
    `hello-agent@${version}`,
    '--project',
    project,
    '--yes',
  ]);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test('installed reflects the lock and outdated compares against the newest stable release', async () => {
  await withProject(async (project) => {
    install(project);

    const installed = cli(['installed', '--project', project, '--json']);
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual(JSON.parse(installed.stdout), [
      {
        id: 'hello-agent',
        version: '1.1.0',
        target: '.agents/skills',
        files: [
          '.agents/skills/hello-agent/SKILL.md',
          '.agents/skills/hello-agent/legacy-notes.md',
        ],
      },
    ]);

    const outdated = cli(['outdated', '--project', project, '--json']);
    assert.equal(outdated.status, 0, outdated.stderr);
    assert.deepEqual(JSON.parse(outdated.stdout), [
      {
        id: 'hello-agent',
        lockedVersion: '1.1.0',
        latestStable: '1.2.0',
        target: '.agents/skills',
        availability: 'outdated',
      },
    ]);
  });
});

test('update previews content diffs and requires confirmation; a successful update leaves removed files as orphans', async () => {
  await withProject(async (project) => {
    install(project);
    const skill = path.join(project, '.agents/skills/hello-agent/SKILL.md');
    const orphan = path.join(
      project,
      '.agents/skills/hello-agent/legacy-notes.md',
    );
    const lockPath = path.join(project, 'lufa.lock.json');
    const originalLock = await readFile(lockPath, 'utf8');
    const beforeUpdatePreview = (await registry.requests()).length;

    const preview = cli([
      'update',
      'hello-agent',
      '--project',
      project,
      '--json',
    ]);
    assert.equal(preview.status, 1);
    assert.match(preview.stderr, /confirmer explicitement avec --yes/);
    const plan = JSON.parse(preview.stdout);
    assert.equal(plan[0].fromVersion, '1.1.0');
    assert.equal(plan[0].toVersion, '1.2.0');
    assert.equal(plan[0].provenance, 'https://github.com/Grasdouble/Lufa-AI');
    assert.equal(plan[0].sourceLocal, 'registre distant ou cache vérifié');
    assert.equal(plan[0].target, '.agents/skills');
    assert.ok(plan[0].changes.some(({ kind }) => kind === 'added'));
    assert.ok(
      plan[0].changes.some(
        ({ kind, diff }) => kind === 'modified' && diff?.includes('+'),
      ),
    );
    const downloadedPaths = (await registry.requests())
      .slice(beforeUpdatePreview)
      .map(({ url }) => url)
      .filter((url) => url.startsWith('/registry/catalog/'));
    assert.deepEqual(
      downloadedPaths.sort(),
      [
        '/registry/catalog/hello-agent/versions/1.2.0/SKILL.md',
        '/registry/catalog/hello-agent/versions/1.2.0/greeting-template.md',
      ].sort(),
    );
    assert.ok(
      plan[0].changes.some(
        ({ kind, path: filePath }) =>
          kind === 'orphan' && filePath.endsWith('legacy-notes.md'),
      ),
    );
    assert.equal(await readFile(lockPath, 'utf8'), originalLock);

    const applied = cli([
      'update',
      'hello-agent',
      '--project',
      project,
      '--yes',
    ]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(
      applied.stdout,
      /Provenance du dépôt : https:\/\/github\.com\/Grasdouble\/Lufa-AI/,
    );
    assert.match(
      applied.stdout,
      /Source locale lue : registre distant ou cache vérifié/,
    );
    assert.match(applied.stdout, /Orphelin conservé \(non supprimé\)/);
    assert.equal(
      await readFile(orphan, 'utf8'),
      await readFile(
        path.join(
          repoRoot,
          'catalog/hello-agent/versions/1.1.0/legacy-notes.md',
        ),
        'utf8',
      ),
    );
    assert.equal(
      await readFile(skill, 'utf8'),
      await readFile(
        path.join(repoRoot, 'catalog/hello-agent/versions/1.2.0/SKILL.md'),
        'utf8',
      ),
    );
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(lock.installs[0].version, '1.2.0');
    assert.deepEqual(
      lock.installs[0].files.map(({ path: filePath }) => filePath),
      [
        '.agents/skills/hello-agent/SKILL.md',
        '.agents/skills/hello-agent/greeting-template.md',
      ],
    );
    for (const file of lock.installs[0].files) {
      const contents = await readFile(path.join(project, file.path));
      assert.equal(
        file.sha256,
        createHash('sha256').update(contents).digest('hex'),
      );
    }
    assert.equal(
      lock.installs[0].files.some(({ path: filePath }) =>
        filePath.endsWith('legacy-notes.md'),
      ),
      false,
    );

    const current = cli(['outdated', '--project', project, '--json']);
    assert.equal(current.status, 0, current.stderr);
    assert.equal(JSON.parse(current.stdout)[0].availability, 'up-to-date');
    const beforeCurrentUpdate = (await registry.requests()).length;
    const currentUpdate = cli(['update', 'hello-agent', '--project', project]);
    assert.equal(currentUpdate.status, 0, currentUpdate.stderr);
    assert.match(currentUpdate.stdout, /déjà à jour/);
    assert.equal(
      (await registry.requests())
        .slice(beforeCurrentUpdate)
        .some(({ url }) => url.startsWith('/registry/catalog/')),
      false,
    );
  });
});

test('local SHA-256 conflicts stop by default; --force backs up the local file before replacing it', async () => {
  await withProject(async (project) => {
    install(project);
    const skill = path.join(project, '.agents/skills/hello-agent/SKILL.md');
    const localText = '# Local instructions\nKeep my custom greeting.\n';
    await writeFile(skill, localText);
    const lockPath = path.join(project, 'lufa.lock.json');
    const originalLock = await readFile(lockPath, 'utf8');
    const beforeBlockedUpdate = (await registry.requests()).length;

    const blocked = cli([
      'update',
      'hello-agent',
      '--project',
      project,
      '--yes',
    ]);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stdout, /conflit local/);
    assert.match(blocked.stderr, /Utiliser --force/);
    assert.equal(
      (await registry.requests())
        .slice(beforeBlockedUpdate)
        .some(({ url }) => url.startsWith('/registry/catalog/')),
      false,
    );
    assert.equal(await readFile(skill, 'utf8'), localText);
    assert.equal(await readFile(lockPath, 'utf8'), originalLock);

    const forced = cli([
      'update',
      'hello-agent',
      '--project',
      project,
      '--force',
      '--yes',
    ]);
    assert.equal(forced.status, 0, forced.stderr);
    const backupLine = forced.stdout
      .split('\n')
      .find((line) => line.startsWith('Sauvegarde : '));
    assert.ok(backupLine, forced.stdout);
    const backupPath = path.join(
      project,
      backupLine.slice('Sauvegarde : '.length),
    );
    assert.equal(await readFile(backupPath, 'utf8'), localText);
    assert.match(backupLine, /^Sauvegarde : \.lufa\/backups\//);
    assert.notEqual(await readFile(skill, 'utf8'), localText);
  });
});

test('a rejected remote update checksum leaves every project file and lock unchanged', async () => {
  await withProject(async (project) => {
    install(project);
    const lockPath = path.join(project, 'lufa.lock.json');
    const originalLock = await readFile(lockPath, 'utf8');
    const originalSkill = await readFile(
      path.join(project, '.agents/skills/hello-agent/SKILL.md'),
    );
    const originalOrphan = await readFile(
      path.join(project, '.agents/skills/hello-agent/legacy-notes.md'),
    );
    const invalid = structuredClone(
      JSON.parse(
        await readFile(
          new URL('../generated/catalog-index.json', import.meta.url),
          'utf8',
        ),
      ),
    );
    invalid.artifacts[0].versions.find(
      ({ version }) => version === '1.2.0',
    ).files[0].sha256 = 'c'.repeat(64);
    await registry.setResponse(invalid);
    try {
      const result = cli([
        'update',
        'hello-agent',
        '--project',
        project,
        '--yes',
      ]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Checksum SHA-256 invalide/);
      assert.equal(await readFile(lockPath, 'utf8'), originalLock);
      assert.deepEqual(
        await readFile(
          path.join(project, '.agents/skills/hello-agent/SKILL.md'),
        ),
        originalSkill,
      );
      assert.deepEqual(
        await readFile(
          path.join(project, '.agents/skills/hello-agent/legacy-notes.md'),
        ),
        originalOrphan,
      );
      await assert.rejects(
        readFile(
          path.join(project, '.agents/skills/hello-agent/greeting-template.md'),
        ),
      );
    } finally {
      await registry.setResponse(
        JSON.parse(
          await readFile(
            new URL('../generated/catalog-index.json', import.meta.url),
            'utf8',
          ),
        ),
      );
    }
  });
});

test('ordinary failure before lock commit rolls back additions and modifications and keeps the exact old lock', async () => {
  await withProject(async (project) => {
    install(project);
    const skill = path.join(project, '.agents/skills/hello-agent/SKILL.md');
    const template = path.join(
      project,
      '.agents/skills/hello-agent/greeting-template.md',
    );
    const originalSkill = await readFile(skill);
    const originalLock = await readFile(path.join(project, 'lufa.lock.json'));
    let sawTemplate = false;

    await assert.rejects(
      runUpdateCommand(['hello-agent', '--yes'], {
        project,
        catalogRoot: repoRoot,
        interactive: true,
        confirm: async () => true,
        onBeforeLockCommit: async () => {
          sawTemplate = true;
          throw new Error('simulated lock commit failure');
        },
      }),
      /simulated lock commit failure.*restaurés/,
    );

    assert.equal(sawTemplate, true);
    assert.deepEqual(await readFile(skill), originalSkill);
    assert.deepEqual(
      await readFile(path.join(project, 'lufa.lock.json')),
      originalLock,
    );
    await assert.rejects(lstat(template), { code: 'ENOENT' });
  });
});

test('a declined update confirmation changes neither files nor lock', async () => {
  await withProject(async (project) => {
    install(project);
    const lockPath = path.join(project, 'lufa.lock.json');
    const originalLock = await readFile(lockPath);
    const originalSkill = await readFile(
      path.join(project, '.agents/skills/hello-agent/SKILL.md'),
    );
    const originalLog = console.log;
    console.log = () => {};
    try {
      await runUpdateCommand(['hello-agent'], {
        project,
        catalogRoot: repoRoot,
        interactive: true,
        confirm: async () => false,
      });
    } finally {
      console.log = originalLog;
    }
    assert.deepEqual(await readFile(lockPath), originalLock);
    assert.deepEqual(
      await readFile(path.join(project, '.agents/skills/hello-agent/SKILL.md')),
      originalSkill,
    );
  });
});

test('rollback preserves an added file when its skill parent is moved outside and replaced by a symlink', async (t) => {
  await withProject(async (project) => {
    install(project);
    const lockPath = path.join(project, 'lufa.lock.json');
    const originalLock = await readFile(lockPath);
    const skillsRoot = path.join(project, '.agents/skills');
    const skillDirectory = path.join(skillsRoot, 'hello-agent');
    const externalRoot = await mkdtemp(
      path.join(tmpdir(), 'lufa-update-external-'),
    );
    const movedDirectory = path.join(externalRoot, 'moved-skill');
    const externalSentinel = path.join(externalRoot, 'greeting-template.md');
    const userFile = path.join(skillDirectory, 'user-content.md');
    try {
      await writeFile(userFile, 'User-authored content must survive.\n');
      await writeFile(externalSentinel, 'External user file must survive.\n');

      if (process.platform === 'win32') {
        const symlinkProbe = path.join(externalRoot, 'symlink-probe');
        try {
          await symlink(project, symlinkProbe, 'junction');
        } catch (error) {
          if (error.code === 'EPERM') {
            t.skip('Le runner Windows ne permet pas la création de jonctions.');
            return;
          }
          throw error;
        }
        await rm(symlinkProbe);
      }

      await assert.rejects(
        runUpdateCommand(['hello-agent', '--yes'], {
          project,
          catalogRoot: repoRoot,
          interactive: true,
          confirm: async () => true,
          onBeforeLockCommit: async () => {
            await rename(skillDirectory, movedDirectory);
            await symlink(
              externalRoot,
              skillDirectory,
              process.platform === 'win32' ? 'junction' : 'dir',
            );
            throw new Error('simulated failure after moving skill directory');
          },
        }),
        /simulated failure.*Rollback incomplet.*résidu préservé/s,
      );

      assert.equal(
        await readFile(path.join(movedDirectory, 'user-content.md'), 'utf8'),
        'User-authored content must survive.\n',
      );
      assert.equal(
        await readFile(externalSentinel, 'utf8'),
        'External user file must survive.\n',
      );
      assert.equal(
        await readFile(
          path.join(movedDirectory, 'greeting-template.md'),
          'utf8',
        ),
        await readFile(
          path.join(
            repoRoot,
            'catalog/hello-agent/versions/1.2.0/greeting-template.md',
          ),
          'utf8',
        ),
      );
      assert.deepEqual(await readFile(lockPath), originalLock);
      assert.equal(
        JSON.parse(await readFile(lockPath, 'utf8')).installs[0].version,
        '1.1.0',
      );
      assert.deepEqual(
        (await readdir(externalRoot)).sort(),
        ['greeting-template.md', 'moved-skill'].sort(),
      );
    } finally {
      await rm(externalRoot, { recursive: true, force: true });
    }
  });
});

test('update and install use the shared per-project lock', async () => {
  await withProject(async (project) => {
    install(project);
    let releaseConfirmation;
    let reachedConfirmation;
    const confirmationReached = new Promise((resolve) => {
      reachedConfirmation = resolve;
    });
    const confirmed = new Promise((resolve) => {
      releaseConfirmation = resolve;
    });
    const update = runUpdateCommand(['hello-agent'], {
      project,
      catalogRoot: repoRoot,
      interactive: true,
      confirm: async () => {
        reachedConfirmation();
        return confirmed;
      },
    });
    await confirmationReached;
    let installWaited = false;
    const concurrentInstall = runInstallCommand(['hello-agent', '--yes'], {
      project,
      catalogRoot: repoRoot,
      interactive: true,
      onProjectLockWait: () => {
        installWaited = true;
      },
    });
    while (!installWaited)
      await new Promise((resolve) => setTimeout(resolve, 5));
    releaseConfirmation(true);
    await update;
    await concurrentInstall;
    const lock = JSON.parse(
      await readFile(path.join(project, 'lufa.lock.json'), 'utf8'),
    );
    assert.equal(lock.installs[0].version, '1.2.0');
  });
});
