// Local server for trying the app: the static files, never cached, so a reload always runs the latest code.
// Localhost only (the microphone needs localhost or HTTPS anyway).   npm run serve  /  node scripts/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.argv[2]) || 8080;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

// The headers CloudFront adds to the app in production (deploy/rt-headers.json), so it is tried here under the same rules:
// a browser feature its Permissions-Policy leaves out fails here first, not on the live site. All but HSTS, which from
// localhost would hold every other server on this machine to HTTPS.
const policy = JSON.parse(await readFile(join(root, 'deploy', 'rt-headers.json'), 'utf8'));
const security = policy.SecurityHeadersConfig;
const HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': security.FrameOptions.FrameOption,
  'referrer-policy': security.ReferrerPolicy.ReferrerPolicy,
  'content-security-policy': security.ContentSecurityPolicy.ContentSecurityPolicy,
  ...Object.fromEntries(policy.CustomHeadersConfig.Items.map(h => [h.Header.toLowerCase(), h.Value])),
};

// This machine's own names only: a web page that points a name of its own at 127.0.0.1 (DNS rebinding) is turned away,
// so it can't read what is served here.
const HOSTS = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);

createServer(async (req, res) => {
  if (!HOSTS.has(req.headers.host)) { res.writeHead(403).end(); return; }
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400).end(); return; }             // "/%" used to throw, and took the server down with it
  if (path.split('/').some(s => s.startsWith('.'))) { res.writeHead(404).end(); return; }   // .git, .claude, an .env
  const file = join(root, path.endsWith('/') ? join(path, 'index.html') : path);
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...HEADERS, 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`RT Trainer on http://localhost:${port}`));
