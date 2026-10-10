import assert from 'node:assert/strict';
import { access, readFile, realpath, stat } from 'node:fs/promises';
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
const readPage = (relativePath) =>
  readFile(path.join(siteRoot, relativePath), 'utf8');

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
  });
  response.end(text);
}

async function serveBuiltCatalog(request, response, root) {
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

    const html = await readFile(resolvedPath);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
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
