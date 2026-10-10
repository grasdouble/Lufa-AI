import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const result = spawnSync(
  process.execPath,
  [path.join(repositoryRoot, 'node_modules/astro/bin/astro.mjs'), 'build'],
  {
    cwd: path.join(repositoryRoot, 'web'),
    env: {
      ...process.env,
      ASTRO_BASE: '/Lufa-AI',
      ASTRO_OUT_DIR: './dist-pages',
    },
    stdio: 'inherit',
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
