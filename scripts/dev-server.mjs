/**
 * dev-server.mjs — static file server with caching turned off.
 *
 * `python3 -m http.server` sends Last-Modified but no Cache-Control, so
 * browsers apply heuristic freshness and happily serve a stale ES module after
 * you have edited it. Since the app is a graph of static imports, one cached
 * module is enough to make an edit look like it did nothing. This server sends
 * `no-store` on everything, so a reload is always a real reload.
 *
 * Node's standard library only — no dependency to install.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(process.argv[3] || '.');
const PORT = Number(process.argv[2]) || 5190;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.bpmn': 'application/xml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mmd': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // normalize() collapses `..`, and the resolve check keeps the served tree
    // inside ROOT even if something slips through.
    let path = join(ROOT, normalize(decodeURIComponent(url.pathname)));
    if (!resolve(path).startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let info = await stat(path).catch(() => null);
    if (info?.isDirectory()) {
      path = join(path, 'index.html');
      info = await stat(path).catch(() => null);
    }
    if (!info) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }

    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(path)] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache'
    }).end(body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(err.message));
  }
}).listen(PORT, () => {
  console.log(`Text2Workflow dev server → http://localhost:${PORT}  (serving ${ROOT}, caching disabled)`);
});
