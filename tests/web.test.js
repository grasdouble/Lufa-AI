import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import {
  initializeCatalogSearch,
  matchesCatalogItem,
} from '../web/src/scripts/catalog-search.js';

const projectRoot = process.cwd();
const siteRoot = path.join(projectRoot, 'web', 'dist');
const pagesSiteRoot = path.join(projectRoot, 'web', 'dist-pages');
const pagesBase = '/Lufa-AI';
const readPage = (relativePath, root = siteRoot) =>
  readFile(path.join(root, relativePath), 'utf8');

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
  });
  response.end(text);
}

async function serveBuiltCatalog(request, response, root, basePath = '') {
  if (request.method !== 'GET') {
    sendText(response, 405, 'Method not allowed');
    return;
  }

  const rawPath = (request.url ?? '/').split('?', 1)[0];
  let pathname;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    sendText(response, 400, 'Invalid URL encoding');
    return;
  }

  if (!pathname.startsWith('/') || pathname.startsWith('//')) {
    sendText(response, 400, 'Invalid path');
    return;
  }

  if (basePath) {
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
      sendText(response, 404, 'Not found');
      return;
    }
    pathname = pathname.slice(basePath.length) || '/';
  }

  const segments = pathname.split('/').filter(Boolean);
  if (
    segments.some(
      (segment) =>
        segment === '.' ||
        segment === '..' ||
        /[\\:\0]/.test(segment) ||
        segment.includes('/'),
    )
  ) {
    sendText(response, 400, 'Invalid path');
    return;
  }

  if (segments.length === 0 || pathname.endsWith('/')) {
    segments.push('index.html');
  }

  const filePath = path.resolve(root, ...segments);
  const relativePath = path.relative(root, filePath);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    sendText(response, 400, 'Invalid path');
    return;
  }

  try {
    const resolvedPath = await realpath(filePath);
    const resolvedRelativePath = path.relative(root, resolvedPath);
    if (
      resolvedRelativePath === '..' ||
      resolvedRelativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(resolvedRelativePath) ||
      !(await stat(resolvedPath)).isFile()
    ) {
      sendText(response, 404, 'Not found');
      return;
    }

    const contentTypes = {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.md': 'text/markdown; charset=utf-8',
    };
    const contents = await readFile(resolvedPath);
    response.writeHead(200, {
      'content-type':
        contentTypes[path.extname(resolvedPath)] ?? 'application/octet-stream',
    });
    response.end(contents);
  } catch {
    sendText(response, 404, 'Not found');
  }
}

test('site build contains a semantic, filterable catalogue and pilot detail route', async () => {
  const [home, detail] = await Promise.all([
    readPage('index.html'),
    readPage('artifacts/hello-agent/index.html'),
  ]);

  assert.match(home, /<html lang="fr">/);
  assert.match(home, /<main id="main">/);
  assert.match(home, /<h1[^>]*>Trouvez le bon/);
  assert.match(home, /id="catalog-query"[^>]*type="search"/);
  assert.match(home, /id="filter-type"/);
  assert.match(home, /id="filter-environment"/);
  assert.match(home, /id="filter-category"/);
  assert.match(home, /type="submit"/);
  assert.match(home, /role="search"/);
  assert.match(home, /aria-live="polite"/);
  assert.match(home, /id="no-results"[^>]*hidden/);
  assert.match(home, /id="artifact-list"/);
  assert.match(home, /href="\/artifacts\/hello-agent\/"/);
  assert.match(home, /lecture seule/i);

  assert.match(detail, /<h1>Hello Agent<\/h1>/);
  assert.match(detail, /1\.2\.0/);
  assert.match(detail, /Lufa AI maintainers/);
  assert.match(detail, /MIT/);
  assert.match(detail, /github-copilot/);
  assert.match(detail, /opencode/);
  assert.match(detail, /declared/);
  assert.match(detail, /verified/);
  assert.match(detail, /Compatibilité déclarée, non vérifiée/);
  assert.match(detail, /SKILL\.md/);
  assert.match(detail, /greeting-template\.md/);
  assert.match(detail, /When asked to greet or welcome someone/);
  assert.match(detail, /lufa install hello-agent/);
  assert.match(detail, /n’exécute pas le contenu/);
});

test('built static catalogue serves pages over HTTP without starting Astro', async () => {
  const root = await realpath(siteRoot);
  const server = createServer((request, response) => {
    void serveBuiltCatalog(request, response, root);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const homeResponse = await fetch(`${origin}/`);
    assert.equal(homeResponse.status, 200);
    assert.match(await homeResponse.text(), /Lufa AI/);

    const detailResponse = await fetch(`${origin}/artifacts/hello-agent/`);
    assert.equal(detailResponse.status, 200);
    assert.match(await detailResponse.text(), /Hello Agent/);

    const traversalResponse = await fetch(`${origin}/..%2f..%2fREADME.md`);
    assert.equal(traversalResponse.status, 400);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
});

test('generated internal links and accessibility references resolve', async () => {
  const pages = [
    ['index.html', await readPage('index.html')],
    [
      'artifacts/hello-agent/index.html',
      await readPage('artifacts/hello-agent/index.html'),
    ],
  ];

  for (const [pagePath, html] of pages) {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${pagePath} has unique ids`);

    for (const attribute of ['aria-labelledby', 'aria-controls']) {
      for (const [, value] of html.matchAll(
        new RegExp(`${attribute}="([^"]+)"`, 'g'),
      )) {
        for (const referencedId of value.split(/\s+/)) {
          assert.ok(
            ids.includes(referencedId),
            `${pagePath} references #${referencedId}`,
          );
        }
      }
    }

    for (const [, target] of html.matchAll(/\bfor="([^"]+)"/g)) {
      assert.ok(ids.includes(target), `${pagePath} label targets #${target}`);
    }

    for (const [, href] of html.matchAll(/\bhref="([^"]+)"/g)) {
      if (!href.startsWith('/') || href.startsWith('//')) continue;
      const pathname = decodeURIComponent(href.split(/[?#]/, 1)[0]);
      const target = pathname.endsWith('/')
        ? path.join(siteRoot, pathname, 'index.html')
        : path.join(siteRoot, pathname);
      await access(target).catch((error) => {
        assert.fail(
          `${pagePath} has broken internal link ${href}: ${error.message}`,
        );
      });
    }
  }

  assert.match(pages[1][1], /aria-label="Fil d’Ariane"/);
  assert.match(pages[1][1], /aria-current="page"/);
  assert.match(pages[1][1], /Aller au contenu/);
});

test('GitHub Pages build prefixes routes and every bundled asset', async () => {
  const home = await readPage('index.html', pagesSiteRoot);
  const detail = await readPage(
    'artifacts/hello-agent/index.html',
    pagesSiteRoot,
  );
  const pages = [
    ['index.html', home],
    ['artifacts/hello-agent/index.html', detail],
  ];

  assert.match(home, /href="\/Lufa-AI\/"/);
  assert.match(home, /href="\/Lufa-AI\/artifacts\/hello-agent\/"/);
  assert.match(detail, /href="\/Lufa-AI\/"/);
  assert.doesNotMatch(home, /href="\/(?:artifacts|_astro)\//);

  for (const [pagePath, html] of pages) {
    for (const [, value] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      if (value.startsWith('/') && !value.startsWith('//')) {
        assert.ok(
          value === pagesBase || value.startsWith(`${pagesBase}/`),
          `${pagePath} URL uses the Pages base: ${value}`,
        );
        const pathname = decodeURIComponent(value.split(/[?#]/, 1)[0]);
        const relativePath = pathname
          .slice(pagesBase.length)
          .replace(/^\//, '');
        const target =
          !relativePath || relativePath.endsWith('/')
            ? path.join(pagesSiteRoot, relativePath, 'index.html')
            : path.join(pagesSiteRoot, relativePath);
        await access(target);
      }
      if (value.startsWith('/Lufa-AI/_astro/')) {
        const assetPath = value.slice(pagesBase.length + 1);
        await access(path.join(pagesSiteRoot, assetPath));
      }
    }
  }

  assert.match(home, /(?:href|src)="\/Lufa-AI\/_astro\/[^" ]+\.css"/);
  assert.match(home, /<script type="module">/);

  const index = JSON.parse(
    await readFile(
      path.join(projectRoot, 'generated', 'catalog-index.json'),
      'utf8',
    ),
  );
  const expectedRoutes = [
    'index.html',
    ...index.artifacts.map((artifact) => `artifacts/${artifact.id}/index.html`),
  ];
  const actualRoutes = [];
  async function collectHtml(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) {
        await collectHtml(path.join(directory, entry.name), relativePath);
      } else if (entry.name.endsWith('.html')) {
        actualRoutes.push(relativePath);
      }
    }
  }
  await collectHtml(pagesSiteRoot);
  assert.deepEqual(actualRoutes.sort(), expectedRoutes.sort());
});

test('static registry export contains exactly the validated index and payload files', async () => {
  const registryRoot = path.join(siteRoot, 'registry');
  const indexPath = path.join(registryRoot, 'catalog-index.json');
  const index = await readFile(indexPath, 'utf8');
  const committedIndex = await readFile(
    path.join(projectRoot, 'generated', 'catalog-index.json'),
    'utf8',
  );
  assert.equal(index, committedIndex);

  const { artifacts } = JSON.parse(index);
  const expectedPaths = new Set(['catalog-index.json']);
  for (const artifact of artifacts) {
    for (const version of artifact.versions) {
      for (const file of version.files) {
        const relativePath = path.posix.join('catalog', artifact.id, file.path);
        expectedPaths.add(relativePath);
        const published = await readFile(
          path.join(registryRoot, ...relativePath.split('/')),
        );
        const source = await readFile(
          path.join(
            projectRoot,
            'catalog',
            artifact.id,
            ...file.path.split('/'),
          ),
        );
        assert.deepEqual(published, source, `${relativePath} matches source`);
        assert.equal(
          createHash('sha256').update(published).digest('hex'),
          file.sha256,
          `${relativePath} matches the published checksum`,
        );
      }
    }
  }

  const actualPaths = [];
  async function collectFiles(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = path.posix.join(prefix, entry.name);
      const entryPath = path.join(directory, entry.name);
      assert.equal((await lstat(entryPath)).isSymbolicLink(), false);
      if (entry.isDirectory()) {
        await collectFiles(entryPath, relativePath);
      } else {
        actualPaths.push(relativePath);
      }
    }
  }
  await collectFiles(registryRoot);
  assert.deepEqual(actualPaths.sort(), [...expectedPaths].sort());
  assert.ok(!actualPaths.some((entry) => entry.endsWith('artifact.json')));
});

test('prefixed Pages routes serve the site, assets, index, and version files', async () => {
  const root = await realpath(pagesSiteRoot);
  const server = createServer((request, response) => {
    void serveBuiltCatalog(request, response, root, pagesBase);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const homeResponse = await fetch(`${origin}${pagesBase}/`);
    assert.equal(homeResponse.status, 200);
    const home = await homeResponse.text();
    assert.match(home, /Lufa AI/);

    const stylesheet = /href="([^"]+\.css)"/.exec(home)?.[1];
    assert.ok(stylesheet?.startsWith(`${pagesBase}/_astro/`));
    const assetResponse = await fetch(`${origin}${stylesheet}`);
    assert.equal(assetResponse.status, 200);
    assert.match(assetResponse.headers.get('content-type'), /text\/css/);

    const detailResponse = await fetch(
      `${origin}${pagesBase}/artifacts/hello-agent/`,
    );
    assert.equal(detailResponse.status, 200);
    assert.match(await detailResponse.text(), /Hello Agent/);

    const indexResponse = await fetch(
      `${origin}${pagesBase}/registry/catalog-index.json`,
    );
    assert.equal(indexResponse.status, 200);
    assert.match(
      indexResponse.headers.get('content-type'),
      /application\/json/,
    );

    const payloadResponse = await fetch(
      `${origin}${pagesBase}/registry/catalog/hello-agent/versions/1.2.0/SKILL.md`,
    );
    assert.equal(payloadResponse.status, 200);
    assert.match(await payloadResponse.text(), /When asked to greet/);

    assert.equal(
      (await fetch(`${origin}/registry/catalog-index.json`)).status,
      404,
    );
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
});

test('unsafe evidence references are rendered as text, never executable links', async () => {
  const fixture = await readFile(
    path.join(projectRoot, 'tests/fixtures/web-security/dist/index.html'),
    'utf8',
  );

  assert.match(fixture, /javascript:alert\(1\)/);
  assert.match(fixture, /<span[^>]*>javascript:alert\(1\)<\/span>/);
  assert.doesNotMatch(fixture, /href\s*=\s*["']javascript:/i);
  assert.match(fixture, /href="https:\/\/example\.test\/evidence"/);
});

test('catalogue search matches text and filters, and exposes no-results behavior', () => {
  const item = {
    searchText: 'hello-agent Hello Agent greeting writing skill github-copilot',
    type: 'skill',
    environments: ['github-copilot', 'opencode'],
    categories: ['code review'],
  };

  assert.equal(
    matchesCatalogItem(item, {
      query: 'GREETing',
      type: '',
      environment: '',
      category: '',
    }),
    true,
  );
  assert.equal(
    matchesCatalogItem(item, {
      query: '',
      type: 'skill',
      environment: 'opencode',
      category: 'code review',
    }),
    true,
  );
  assert.equal(
    matchesCatalogItem(item, {
      query: 'no-such-skill',
      type: '',
      environment: '',
      category: '',
    }),
    false,
  );

  const listeners = new Map();
  const queryInput = { value: '' };
  const typeSelect = { value: '' };
  const environmentSelect = { value: '' };
  const categorySelect = { value: '' };
  const noResults = { hidden: true };
  const visibleCount = { textContent: '1' };
  const resultLabel = { textContent: 'résultat' };
  const card = {
    dataset: {
      search: item.searchText,
      type: item.type,
      environments: item.environments.join(' '),
      categories: JSON.stringify(item.categories),
    },
    hidden: false,
  };
  const form = {
    addEventListener: (event, callback) => listeners.set(event, callback),
  };
  const elements = new Map([
    ['#catalog-filters', form],
    ['#catalog-query', queryInput],
    ['#filter-type', typeSelect],
    ['#filter-environment', environmentSelect],
    ['#filter-category', categorySelect],
    ['#no-results', noResults],
    ['#visible-count', visibleCount],
    ['#result-label', resultLabel],
  ]);
  const root = {
    querySelector: (selector) => elements.get(selector),
    querySelectorAll: () => [card],
  };

  initializeCatalogSearch(root);
  queryInput.value = 'does-not-exist';
  listeners.get('input')();
  assert.equal(card.hidden, true);
  assert.equal(noResults.hidden, false);
  assert.equal(visibleCount.textContent, '0');
  assert.equal(resultLabel.textContent, 'résultats');

  let defaultPrevented = false;
  listeners.get('submit')({
    preventDefault() {
      defaultPrevented = true;
    },
  });
  assert.equal(defaultPrevented, true);
  assert.equal(card.hidden, true);
  assert.equal(noResults.hidden, false);

  queryInput.value = 'hello';
  listeners.get('input')();
  assert.equal(card.hidden, false);
  assert.equal(noResults.hidden, true);
  assert.equal(visibleCount.textContent, '1');

  categorySelect.value = 'code review';
  listeners.get('change')();
  assert.equal(card.hidden, false);
  categorySelect.value = 'code';
  listeners.get('change')();
  assert.equal(card.hidden, true);
});
