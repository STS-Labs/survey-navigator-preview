// The cleaner's local server: static files, the route list, and saving only *_clean.gpx files.
//   node tests/server_test.mjs
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from '../tools/cleaner_server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
let failures = 0, passes = 0;
const check = (ok, msg) => { if (ok) passes++; else { failures++; console.log('  FAIL', msg); } };

const server = await startServer({ port: 0, host: '127.0.0.1', root });
const base = `http://127.0.0.1:${server.address().port}`;
const tmp = 'zz_test_clean.gpx', tmpPath = root + 'data/routes/' + tmp;
if (existsSync(tmpPath)) unlinkSync(tmpPath);
try {
  let r = await fetch(base + '/js/core.js');
  check(r.status === 200 && /javascript/.test(r.headers.get('content-type')) && r.headers.get('cache-control') === 'no-store', 'serves a module with the right type and no caching');
  r = await fetch(base + '/data/routes/day_01_nav.gpx');
  check(r.status === 200 && /gpx/.test(r.headers.get('content-type')), 'serves a GPX with a gpx type');
  r = await fetch(base + '/nothing-here.txt');
  check(r.status === 404, 'unknown file is 404');
  r = await fetch(base + '/../../../etc/passwd');
  check(r.status === 404 || r.status === 400, 'cannot leave the repo root');
  r = await fetch(base + '/%2e%2e/%2e%2e/etc/passwd');
  check(r.status === 404 || r.status === 400, 'cannot leave the repo root with encoded dots');

  r = await fetch(base + '/api/routes');
  const list = await r.json();
  const day1 = list.find((e) => e.file === 'day_01_nav.gpx');
  check(r.status === 200 && Array.isArray(list) && day1 && day1.bytes > 1000 && day1.clean === false && typeof day1.hasClean === 'boolean', 'lists the routes with size and clean flags');
  check(list.every((e, k) => k === 0 || e.file > list[k - 1].file), 'list is sorted by name');

  r = await fetch(base + '/api/routes/day_01_nav.gpx');
  const text = await r.text();
  check(r.status === 200 && text.startsWith('<?xml') && text.length === readFileSync(root + 'data/routes/day_01_nav.gpx', 'utf8').length, 'returns a route file');
  r = await fetch(base + '/api/routes/..%2Fpackage.json');
  check(r.status === 400, 'route names cannot contain paths');
  r = await fetch(base + '/api/routes/missing.gpx');
  check(r.status === 404, 'missing route is 404');

  r = await fetch(base + '/api/routes/day_01_nav.gpx', { method: 'PUT', body: '<gpx><trkpt/></gpx>' });
  check(r.status === 403, 'an original can never be written');
  r = await fetch(base + '/api/routes/' + tmp, { method: 'PUT', body: 'not a gpx' });
  check(r.status === 400 && !existsSync(tmpPath), 'a body without track points is rejected');
  r = await fetch(base + '/api/routes/' + tmp, { method: 'PUT', body: '<?xml?><gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>' });
  const saved = await r.json();
  check(r.status === 200 && saved.ok && saved.bytes > 0 && saved.path === 'data/routes/' + tmp && existsSync(tmpPath), 'a clean file is written');
  check(!existsSync(tmpPath + '.tmp'), 'no temp file is left behind');
  r = await fetch(base + '/api/routes');
  const e = (await r.json()).find((x) => x.file === tmp);
  check(e && e.clean === true, 'the new file appears in the list as clean');
  r = await fetch(base + '/api/routes/' + tmp, { method: 'POST', body: 'x' });
  check(r.status === 405 && r.headers.get('allow'), 'other methods are 405');
} finally {
  if (existsSync(tmpPath)) unlinkSync(tmpPath);
  server.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
