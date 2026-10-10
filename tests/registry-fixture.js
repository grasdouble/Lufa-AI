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

  return {
    url,
    async setResponse(body, status = 200, headers = {}) {
      const encoded = Buffer.from(
        typeof body === 'string' ? body : JSON.stringify(body),
      ).toString('base64');
      await fetch(`${origin}/__control`, {
        method: 'POST',
        body: JSON.stringify({ body: encoded, headers, status }),
      });
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
