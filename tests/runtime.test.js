import assert from 'node:assert/strict';
import test from 'node:test';

test('runs on a supported Node.js version', () => {
  const majorVersion = Number(process.versions.node.split('.')[0]);

  assert.ok(majorVersion >= 24);
});
