import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from './build-lib.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const typescriptCli = fileURLToPath(
  new URL('../node_modules/typescript/bin/tsc', import.meta.url),
);

await build({
  root: repositoryRoot,
  compiler: (outputDirectory) => {
    const result = spawnSync(
      process.execPath,
      [typescriptCli, '--outDir', outputDirectory],
      { cwd: repositoryRoot, stdio: 'inherit' },
    );

    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`La compilation TypeScript a échoué (${result.status}).`);
    }
  },
});
