import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const APP_SOURCE = fs.readFileSync(path.resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf-8');
const helperStart = APP_SOURCE.indexOf('function extractHtmlErrorDetail');
const helperEnd = APP_SOURCE.indexOf('let eventSource', helperStart);
const HELPER_SOURCE = APP_SOURCE.slice(helperStart, helperEnd);

function loadHelper() {
  const context = { Error, JSON, String };
  vm.createContext(context);
  vm.runInContext(`${HELPER_SOURCE}\nthis.readJsonResponse = readJsonResponse;`, context);
  return context.readJsonResponse;
}

function mockResponse(body, { status = 200, contentType = 'text/html; charset=utf-8' } = {}) {
  return {
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? contentType : null;
      }
    },
    async text() {
      return body;
    }
  };
}

test('反向代理 504 HTML 页面会转换为可读的超时提示', async () => {
  const readJsonResponse = loadHelper();
  await assert.rejects(
    readJsonResponse(mockResponse([
      '<!DOCTYPE html>',
      '<html><head><title>504 Gateway Time-out</title></head>',
      '<body><pre>nginx</pre></body></html>'
    ].join('\n'), { status: 504 })),
    /反向代理等待时间.*后台动作可能仍在执行/
  );
});

test('502 HTML 页面提示容器重启或启动中', async () => {
  const readJsonResponse = loadHelper();
  await assert.rejects(
    readJsonResponse(mockResponse('<!DOCTYPE html><html><body>Bad Gateway</body></html>', { status: 502 })),
    /HTTP 502/
  );
});

test('普通 JSON 响应不受影响', async () => {
  const readJsonResponse = loadHelper();
  const payload = await readJsonResponse(mockResponse(
    '{"success":true,"data":{"progress":2}}',
    { status: 200, contentType: 'application/json; charset=utf-8' }
  ));
  assert.deepEqual(payload, { success: true, data: { progress: 2 } });
});
