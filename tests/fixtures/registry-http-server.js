import { createServer } from 'node:http';

let responseStatus = 200;
let responseBody = Buffer.from(
  process.env.LUFA_TEST_INDEX_BASE64 || '',
  'base64',
);
let responseHeaders = {};
const requests = [];
const fileResponses = new Map();

const server = createServer((request, response) => {
  if (request.url === '/__control' && request.method === 'POST') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const configuration = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const configured = {
        status: configuration.status,
        body: Buffer.from(configuration.body, 'base64'),
        headers: configuration.headers || {},
        delayMs: configuration.delayMs || 0,
      };
      if (configuration.url) fileResponses.set(configuration.url, configured);
      else {
        responseStatus = configured.status;
        responseBody = configured.body;
        responseHeaders = configured.headers;
      }
      response.writeHead(204).end();
    });
    return;
  }
  if (request.url === '/__requests') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(requests));
    return;
  }

  const configured = fileResponses.get(request.url);
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    const selected =
      configured ||
      (request.url === '/registry/catalog-index.json'
        ? {
            status: responseStatus,
            body: responseBody,
            headers: responseHeaders,
            delayMs: 0,
          }
        : {
            status: 404,
            body: Buffer.from('Not found'),
            headers: {},
            delayMs: 0,
          });
    const send = () => {
      response.writeHead(selected.status, {
        'content-type': 'application/json; charset=utf-8',
        ...selected.headers,
      });
      response.end(selected.body);
    };
    if (selected.delayMs) setTimeout(send, selected.delayMs);
    else send();
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`LISTENING ${server.address().port}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
