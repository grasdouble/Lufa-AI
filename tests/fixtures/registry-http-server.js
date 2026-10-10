import { createServer } from 'node:http';

let responseStatus = 200;
let responseBody = Buffer.from(
  process.env.LUFA_TEST_INDEX_BASE64 || '',
  'base64',
);
let responseHeaders = {};
const requests = [];

const server = createServer((request, response) => {
  if (request.url === '/__control' && request.method === 'POST') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const configuration = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      responseStatus = configuration.status;
      responseBody = Buffer.from(configuration.body, 'base64');
      responseHeaders = configuration.headers || {};
      response.writeHead(204).end();
    });
    return;
  }
  if (request.url === '/__requests') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(requests));
    return;
  }

  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    response.writeHead(responseStatus, {
      'content-type': 'application/json; charset=utf-8',
      ...responseHeaders,
    });
    response.end(responseBody);
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`LISTENING ${server.address().port}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
