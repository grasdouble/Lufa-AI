import { lstat, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function build({ root, compiler, renamePath = rename }) {
  const outputDirectory = path.join(root, 'dist');
  const temporaryRoot = await mkdtemp(path.join(root, '.lufa-build-'));
  const generatedDirectory = path.join(temporaryRoot, 'output');
  const backupDirectory = path.join(temporaryRoot, 'backup');
  let backupCreated = false;
  let preserveTemporaryRoot = false;

  try {
    const compilation = await compiler(generatedDirectory);
    if (compilation?.status !== undefined && compilation.status !== 0) {
      throw new Error(
        `La compilation TypeScript a échoué (${compilation.status}).`,
      );
    }

    if (await pathExists(outputDirectory)) {
      await renamePath(outputDirectory, backupDirectory);
      backupCreated = true;
    }

    try {
      await renamePath(generatedDirectory, outputDirectory);
    } catch (commitError) {
      if (backupCreated) {
        try {
          await renamePath(backupDirectory, outputDirectory);
          backupCreated = false;
        } catch (restoreError) {
          preserveTemporaryRoot = true;
          throw new AggregateError(
            [commitError, restoreError],
            `Le commit du build a échoué et l’ancien dist/ n’a pas pu être restauré. Sauvegarde conservée dans ${backupDirectory}.`,
            { cause: restoreError },
          );
        }
      }
      throw commitError;
    }
  } finally {
    if (!preserveTemporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}
