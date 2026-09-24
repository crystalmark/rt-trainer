// The local server (npm run serve), started for real on a spare port and asked for things it should refuse. It is only
// for trying the app on this machine, but it runs from the repo root: the whole history is in .git beside the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';

const port = 18000 + Math.floor(Math.random() * 1000);
function get(path, host = `localhost:${port}`) {
  return new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', err => resolve(err.code));
    req.end();
  });
}

test('the local server serves the app, and nothing else', async () => {
  const server = spawn(process.execPath, [new URL('../scripts/serve.mjs', import.meta.url).pathname, String(port)]);
  await new Promise(resolve => server.stdout.once('data', resolve));    // "RT Trainer on http://localhost:…"
  try {
    assert.equal(await get('/'), 200);
    assert.equal(await get('/js/engine.js'), 200);
    assert.equal(await get('/%'), 400, 'a malformed escape is refused…');
    assert.equal(await get('/'), 200, '…and the server is still up: it used to crash');
    assert.equal(await get('/.git/config'), 404, 'nothing hidden is served');
    assert.equal(await get('/..%2F..%2Fetc%2Fpasswd'), 404, 'nor anything outside the repo');
    assert.equal(await get('/', 'attacker.example'), 403, 'and only this machine’s own names are answered');
  } finally { server.kill(); }
});

// The app is tried here under the headers the live site sends (deploy/rt-headers.json), so a browser feature that the
// Permissions-Policy leaves out fails here first. Never HSTS, which from localhost would hold every other server on this
// machine to HTTPS.
test('the local server sends the live site’s headers, all but HSTS', async () => {
  const at = port + 1;
  const server = spawn(process.execPath, [new URL('../scripts/serve.mjs', import.meta.url).pathname, String(at)]);
  await new Promise(resolve => server.stdout.once('data', resolve));
  try {
    const headers = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: at, path: '/', headers: { host: `localhost:${at}` } }, res => { res.resume(); resolve(res.headers); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['x-frame-options'], 'DENY');
    assert.equal(headers['referrer-policy'], 'same-origin');
    assert.equal(headers['content-security-policy'], "frame-ancestors 'none'");
    assert.match(headers['permissions-policy'], /\bmicrophone=\(self\)/);
    assert.equal(headers['strict-transport-security'], undefined);
  } finally { server.kill(); }
});
