import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const projectRoot = process.cwd();

test('Pages workflow is manual-only and deploys with minimum permissions', async () => {
  const workflow = await readFile(
    path.join(projectRoot, '.github/workflows/pages.yml'),
    'utf8',
  );

  assert.match(workflow, /^on:\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request):/m);
  assert.match(workflow, /ASTRO_BASE: \/Lufa-AI/);
  assert.match(workflow, /path: web\/dist/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /pages: write/);
  assert.match(workflow, /id-token: write/);
});
