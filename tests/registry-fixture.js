import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const serverScript = fileURLToPath(
  new URL('./fixtures/registry-http-server.js', import.meta.url),
);
const bundledIndexPath = new URL(
  '../generated/catalog-index.json',
  import.meta.url,
);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

export async function createRegistryFixture(initialIndex) {
  const initialBody =
    initialIndex ?? JSON.parse(await readFile(bundledIndexPath, 'utf8'));
  const child = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      LUFA_TEST_INDEX_BASE64: Buffer.from(JSON.stringify(initialBody)).toString(
        'base64',
      ),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = /LISTENING (\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!/LISTENING \d+/.test(output)) {
        reject(
          new Error(`Serveur de fixture arrêté avant démarrage (${code}).`),
        );
      }
    });
  });
  const port = await ready;
  const origin = `http://127.0.0.1:${port}`;
  const url = `${origin}/registry/catalog-index.json`;

  async function control(configuration) {
    const body = Buffer.isBuffer(configuration.body)
      ? configuration.body
      : Buffer.from(
          typeof configuration.body === 'string'
            ? configuration.body
            : JSON.stringify(configuration.body),
        );
    const encoded = body.toString('base64');
    await fetch(`${origin}/__control`, {
      method: 'POST',
      body: JSON.stringify({ ...configuration, body: encoded }),
    });
  }

  for (const artifact of initialBody.artifacts || []) {
    for (const version of artifact.versions || []) {
      for (const file of version.files || []) {
        const source = new URL(
          `catalog/${artifact.id}/${file.path}`,
          `file://${repositoryRoot}/`,
        );
        try {
          await control({
            url: `/registry/catalog/${[artifact.id, ...file.path.split('/')].map(encodeURIComponent).join('/')}`,
            body: await readFile(source),
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  }

  return {
    url,
    async setResponse(body, status = 200, headers = {}) {
      await control({ body, headers, status });
    },
    async setFileResponse(
      relativeUrl,
      body,
      status = 200,
      headers = {},
      delayMs = 0,
    ) {
      await control({ url: relativeUrl, body, headers, status, delayMs });
    },
    async requests() {
      return fetch(`${origin}/__requests`).then((response) => response.json());
    },
    async close() {
      child.kill('SIGTERM');
      await once(child, 'exit');
    },
  };
}
