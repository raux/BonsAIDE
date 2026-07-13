import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../out-server/server.js';

async function withServer(fn) {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn(baseUrl);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function request(baseUrl, path, { method = 'GET', body, headers = {} } = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      method,
      path,
      headers,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) { req.write(body); }
    req.end();
  });
}

test('GET / serves the browser UI', async () => {
  await withServer(async baseUrl => {
    const res = await request(baseUrl, '/');

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /Bonsai IDE/);
    assert.match(res.body, /<select id="modelInput"/);
    assert.match(res.body, /Test Pi Model/);
    assert.doesNotMatch(res.body, /baseUrlInput/);
    assert.doesNotMatch(res.body, /LM Studio URL/);
    assert.doesNotMatch(res.body, /deepseek\/deepseek-r1-0528-qwen3-8b<\/option>/);
    assert.match(res.body, /id="issuesExplorer"/);
    assert.match(res.body, /id="issuesList"/);
    assert.match(res.body, /id="selectedIssueBody"/);
    assert.match(res.body, /id="btnAnalyzeRepoForFix"/);
    assert.match(res.body, /id="codeGenerationInstructions"/);
    assert.match(res.body, /Four Isolated Fix Candidates/);
    assert.match(res.body, /id="analysisChecklist"/);
    assert.match(res.body, /id="analysisLogPanel"/);
    assert.match(res.body, /id="fixAlternativesPanel"/);
  });
});

test('serves CSS and JavaScript static assets with content types', async () => {
  await withServer(async baseUrl => {
    const css = await request(baseUrl, '/css/styles.css');
    const js = await request(baseUrl, '/js/app.js');

    assert.equal(css.statusCode, 200);
    assert.match(css.headers['content-type'], /text\/css/);
    assert.equal(js.statusCode, 200);
    assert.match(js.headers['content-type'], /application\/javascript/);
  });
});

test('rejects static path traversal attempts', async () => {
  await withServer(async baseUrl => {
    const res = await request(baseUrl, '/js/../../package.json');

    assert.equal(res.statusCode, 403);
    assert.equal(res.body, 'Forbidden');
  });
});

test('unknown routes return 404 and OPTIONS returns 204', async () => {
  await withServer(async baseUrl => {
    const missing = await request(baseUrl, '/missing');
    const options = await request(baseUrl, '/', { method: 'OPTIONS' });

    assert.equal(missing.statusCode, 404);
    assert.equal(options.statusCode, 204);
  });
});

test('POST /message rejects invalid JSON', async () => {
  await withServer(async baseUrl => {
    const res = await request(baseUrl, '/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.body, /Invalid JSON body/);
  });
});

test('GET /export rejects empty or initial-only sessions', async () => {
  await withServer(async baseUrl => {
    const res = await request(baseUrl, '/export');

    assert.equal(res.statusCode, 400);
    assert.match(res.body, /Cannot export/);
  });
});

test('POST /import accepts valid Bonsai JSON and enables export', async () => {
  await withServer(async baseUrl => {
    const payload = {
      schema: 'bonsai.v1',
      activeBranchId: 'main',
      branches: [
        {
          id: 'main',
          name: 'Main',
          nodes: [
            { id: 1, prompt: 'Initial code', code: 'root', parentId: null, isLeaf: false, activity: 'initial' },
            { id: 2, prompt: 'Refactor', code: 'child', parentId: 1, isLeaf: true, activity: 'refactor' },
          ],
        },
      ],
    };

    const importRes = await request(baseUrl, '/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const exportRes = await request(baseUrl, '/export');

    assert.equal(importRes.statusCode, 204);
    assert.equal(exportRes.statusCode, 200);
    assert.match(exportRes.headers['content-disposition'], /bonsai-/);
    const exported = JSON.parse(exportRes.body);
    assert.equal(exported.schema, 'bonsai.v1');
    assert.equal(exported.branches[0].nodes.length, 2);
  });
});

test('GET /events opens an SSE stream', async () => {
  await withServer(async baseUrl => {
    const url = new URL(baseUrl);
    await new Promise((resolve, reject) => {
      const req = http.request({ hostname: url.hostname, port: url.port, path: '/events', method: 'GET' }, res => {
        try {
          assert.equal(res.statusCode, 200);
          assert.match(res.headers['content-type'], /text\/event-stream/);
          res.destroy();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      req.on('error', reject);
      req.end();
    });
  });
});
