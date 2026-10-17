// Local server for the route cleaner: serves this folder and saves cleaned routes.
//   node tools/cleaner_server.mjs [port]        then open http://127.0.0.1:8791/cleaner/
// Only files named *_clean.gpx can be written, and only into data/routes: the originals never change.
import { createServer } from 'node:http';
import { readFile, readdir, stat, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, sep, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8', '.gpx': 'application/gpx+xml; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
  '.m4a': 'audio/mp4', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.gpx$/;
const CLEAN = /_clean\.gpx$/;
const LIMIT = 32 * 1024 * 1024;

export function startServer({ port = 8791, host = '127.0.0.1', root = fileURLToPath(new URL('..', import.meta.url)) } = {}) {
  root = resolve(root);
  const routesDir = resolve(root, 'data/routes');
  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const safeName = (s) => { try { s = decodeURIComponent(s); } catch { return null; } return NAME.test(s) && basename(s) === s && !s.includes('..') ? s : null; };

  async function listRoutes(res) {
    const names = (await readdir(routesDir)).filter((f) => f.endsWith('.gpx')).sort();
    const out = [];
    for (const file of names) {
      const st = await stat(resolve(routesDir, file));
      const clean = CLEAN.test(file);
      out.push({ file, bytes: st.size, mtime: st.mtime.toISOString(), clean, hasClean: !clean && names.includes(file.replace(/\.gpx$/, '_clean.gpx')) });
    }
    json(res, 200, out);
  }

  async function putRoute(req, res, file) {
    if (!CLEAN.test(file)) return json(res, 403, { error: 'only *_clean.gpx files can be written' });
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > LIMIT) return json(res, 413, { error: 'file too large' }); chunks.push(c); }
    const body = Buffer.concat(chunks).toString('utf8');
    if (!/<gpx\b/.test(body) || !/<trkpt\b/.test(body)) return json(res, 400, { error: 'not a GPX with track points' });
    const path = resolve(routesDir, file), tmp = path + '.tmp';
    try { await writeFile(tmp, body); await rename(tmp, path); }
    catch (e) { try { await unlink(tmp); } catch { /* nothing to remove */ } return json(res, 500, { error: e.message }); }
    json(res, 200, { ok: true, bytes: Buffer.byteLength(body), path: 'data/routes/' + file });
  }

  async function serveFile(res, path) {
    let st;
    try { st = await stat(path); } catch { return json(res, 404, { error: 'not found' }); }
    if (st.isDirectory()) return serveFile(res, resolve(path, 'index.html'));
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': MIME[extname(path).toLowerCase()] || 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
    res.end(data);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const m = /^\/api\/routes(?:\/([^/]+))?$/.exec(url.pathname);
      if (m) {
        if (!m[1]) {
          if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return json(res, 405, { error: 'method not allowed' }); }
          return listRoutes(res);
        }
        const file = safeName(m[1]);
        if (!file) return json(res, 400, { error: 'bad route name' });
        if (req.method === 'GET') return serveFile(res, resolve(routesDir, file));
        if (req.method === 'PUT') return putRoute(req, res, file);
        res.setHeader('Allow', 'GET, PUT');
        return json(res, 405, { error: 'method not allowed' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); return json(res, 405, { error: 'method not allowed' }); }
      let rel;
      try { rel = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: 'bad path' }); }
      const path = resolve(root, '.' + rel);
      if (path !== root && !path.startsWith(root + sep)) return json(res, 400, { error: 'bad path' });
      return serveFile(res, path);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });
  return new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, () => ok(server)); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = +(process.argv[2] || 8791);
  const server = await startServer({ port });
  const a = server.address();
  console.log(`route cleaner: http://${a.address}:${a.port}/cleaner/   (saves go to data/routes/<name>_clean.gpx)`);
}
