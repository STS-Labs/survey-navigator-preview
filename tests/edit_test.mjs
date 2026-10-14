// Tests for js/edit.js (the route cleaner) on the real survey files.
//   node tests/edit_test.mjs                       cheap tests on every file in data/routes, heavy ones on day_01
//   node tests/edit_test.mjs day.gpx [net.json]    everything on one file
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prepare, parseGpx } from '../js/core.js';
import * as E from '../js/edit.js';

const here = (p) => fileURLToPath(new URL('../' + p, import.meta.url));
const [oneGpx, netPath = here('data/tbilisi-net.json')] = process.argv.slice(2);
const netDoc = JSON.parse(readFileSync(netPath, 'utf8'));
const files = oneGpx ? [oneGpx] : readdirSync(here('data/routes')).filter((f) => f.endsWith('.gpx') && !f.endsWith('_clean.gpx')).sort().map((f) => here('data/routes/' + f));
const heavy = oneGpx || files.find((f) => f.endsWith('day_01_nav.gpx')) || files[0];

let failures = 0, passes = 0;
const check = (ok, msg) => { if (ok) passes++; else { failures++; console.log('  FAIL', msg); } };
const section = (name) => console.log(name);
const uturnCount = (route) => route.maneuvers.filter((m) => m.kind === 'uturn').length;
const dist = (r, i, j) => Math.hypot(r.X[i] - r.X[j], r.Y[i] - r.Y[j]);

/* T8: output names */
section('T8 cleanName');
check(E.cleanName('day_01_nav.gpx') === 'day_01_nav_clean.gpx', 'day_01_nav.gpx -> day_01_nav_clean.gpx');
check(E.cleanName('day_01_nav_clean.gpx') === 'day_01_nav_clean.gpx', 'cleanName is idempotent');
check(E.cleanName('zuka-testdrive.gpx') === 'zuka-testdrive_clean.gpx', 'zuka-testdrive.gpx -> zuka-testdrive_clean.gpx');

/* T1: opening a file gives a document that is a fixed point of the engine */
section('T1 fixed point');
const docs = new Map();
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const ref = prepare(text, netDoc).route;
  const doc = E.openDoc(text, netDoc, { file: f.split('/').pop() });
  docs.set(f, doc);
  const name = f.split('/').pop();
  check(doc.points.length === doc.route.X.length, `${name}: one point per route vertex`);
  check(uturnCount(doc.route) === uturnCount(ref), `${name}: same U-turn count as prepare() (${uturnCount(doc.route)} vs ${uturnCount(ref)})`);
  check(Math.abs(doc.route.total - ref.total) < 2, `${name}: same length as prepare()`);
  const n0 = doc.route.X.length, half0 = Int32Array.from(doc.route.half), total0 = doc.route.total;
  E.rebuild(doc);
  let diff = 0;
  if (doc.route.X.length === n0) for (let i = 0; i < half0.length; i++) if (half0[i] !== doc.route.half[i]) diff++;
  check(doc.route.X.length === n0 && diff === 0 && Math.abs(doc.route.total - total0) < 0.01, `${name}: rebuild is a fixed point (n ${n0}, half diffs ${diff})`);
  check(doc.home && Math.abs(doc.home[0] - doc.route.lat[0]) < 1e-6, `${name}: home is the first vertex`);
  check(doc.dirty === false && doc.history.length === 0, `${name}: opens clean`);
}

/* T3: coverage table counts every street segment the route drives */
section('T3 coverage');
for (const [f, doc] of docs) {
  const name = f.split('/').pop(), r = doc.route;
  let onStreet = 0, sum = 0, under = 0;
  for (let i = 0; i < r.half.length; i++) if (r.half[i] >= 0) { onStreet++; if (doc.cov[r.half[i] >> 1] < 1) under++; }
  for (const c of doc.cov) sum += c;
  check(sum === onStreet, `${name}: passes sum to the on-street segment count (${sum} vs ${onStreet})`);
  check(under === 0, `${name}: every driven segment has at least one pass`);
  const runs = E.halfRuns(r);
  let contiguous = runs[0].i0 === 0 && runs[runs.length - 1].i1 === r.half.length, distinct = true;
  for (let k = 1; k < runs.length; k++) { if (runs[k].i0 !== runs[k - 1].i1) contiguous = false; if (runs[k].h === runs[k - 1].h) distinct = false; }
  check(contiguous && distinct, `${name}: half runs tile the route and merge equal neighbours`);
}

/* T2: every U-turn of the engine becomes one review item */
section('T2 U-turn analysis');
{
  const doc = docs.get(heavy), r = doc.route, U = doc.uturns, M = r.maneuvers.filter((m) => m.kind === 'uturn');
  check(U.length === M.length, `one item per engine U-turn (${U.length} vs ${M.length})`);
  check(U.every((u, k) => u.k === k && u.i === M[k].i), 'items keep the engine order and apex index');
  check(U.every((u) => ['deadEnd', 'spur', 'midStreet'].includes(u.type)), 'every item has a type');
  check(U.filter((u) => u.type === 'deadEnd').length === M.filter((m) => m.deadEnd).length, 'dead-end count matches the engine flag');
  const retrace = U.filter((u) => u.type !== 'midStreet');
  check(retrace.length > 0 && retrace.every((u) => u.K >= 1 && u.a < u.i && u.i < u.b), 'retrace items have an extent around the apex');
  check(retrace.every((u) => u.partial || dist(r, u.a, u.b) < 0.5), 'a full retrace returns to where it left');
  check(retrace.every((u) => u.spurMeters > 0 && Math.abs(u.loopMeters - (r.along[u.b] - r.along[u.a])) < 1e-6), 'spur and loop lengths follow the along-distance');
  const merged = M.filter((m) => m.mergedTo != null);
  check(merged.every((m) => U[M.indexOf(m)].type === 'midStreet' && U[M.indexOf(m)].K === 0 && U[M.indexOf(m)].b === m.mergedTo), `merged (divided-road) U-turns are mid-street with no extent (${merged.length} found)`);
  check(U.every((u) => typeof u.verdict.ok === 'boolean' && u.verdict.lostMeters >= 0 && Math.abs(u.verdict.lostMeters - u.verdict.lost.reduce((t, l) => t + l.meters, 0)) < 1e-6), 'verdict totals its lost streets');
  check(U.every((u) => Math.abs(u.lat - r.lat[u.i]) < 1e-9 && Math.abs(u.along - r.along[u.i]) < 1e-9), 'items carry apex position and km');
  const kinds = {}; for (const u of U) kinds[u.type] = (kinds[u.type] || 0) + 1;
  const safe = U.filter((u) => u.verdict.ok).length;
  console.log(`  ${heavy.split('/').pop()}: ${JSON.stringify(kinds)}, ${safe} safe to cut`);
}

/* T4: cutting a spur removes exactly that U-turn and that driving; undo puts it back */
section('T4 cutSpur / undo / redo');
{
  const doc = docs.get(heavy);
  const before = { points: doc.points, n: doc.route.X.length, total: doc.route.total, uturns: doc.uturns.length };
  const u = doc.uturns.find((v) => v.type === 'deadEnd' && !v.partial);
  check(!!u, 'day has a full dead-end spur to cut');
  const expectDelta = -(doc.route.along[u.b] - doc.route.along[u.a] - dist(doc.route, u.a, u.b));
  const res = E.cutSpur(doc, u);
  check(res && res.label.includes('cut'), 'cut returns a labelled result');
  check(doc.uturns.length === before.uturns - 1, `one U-turn fewer (${doc.uturns.length} vs ${before.uturns})`);
  check(Math.abs(res.deltaMeters - expectDelta) < 1, `length drops by the loop (${res.deltaMeters.toFixed(1)} vs ${expectDelta.toFixed(1)})`);
  check(Math.abs(doc.route.total - before.total - res.deltaMeters) < 0.01, 'delta matches the new total');
  check(doc.points.slice(0, u.a + 1).every((p, i) => p[0] === before.points[i][0] && p[1] === before.points[i][1]), 'route before the spur is untouched');
  check(doc.points.length === before.n - (u.b - u.a), 'the spur vertices are gone');
  check(doc.dirty === true && doc.history.length === 1 && doc.future.length === 0, 'document is dirty with one history entry');
  check(res.uturnsBefore === before.uturns && res.uturnsAfter === before.uturns - 1, 'result reports U-turn counts');
  check(Math.abs(res.coverage.lostMeters - u.verdict.lostMeters) < 1, `coverage diff agrees with the verdict (${res.coverage.lostMeters.toFixed(0)} m lost)`);
  check(E.cutSpur(doc, { ...u, K: 0 }) === null, 'a U-turn without a spur cannot be cut');
  check(E.undo(doc) === true, 'undo works');
  check(doc.points.length === before.n && doc.points.every((p, i) => p[0] === before.points[i][0] && p[1] === before.points[i][1]), 'undo restores every point');
  check(doc.uturns.length === before.uturns && doc.dirty === false, 'undo restores the U-turns and the clean state');
  check(E.undo(doc) === false, 'nothing more to undo');
  check(E.redo(doc) === true && doc.points.length === before.n - (u.b - u.a) && doc.dirty === true, 'redo re-applies the cut');
  E.undo(doc);
}

/* T5: the written GPX reads back as the same route, with planned points in sync with the track */
section('T5 writeGpx round trip');
for (const [f, doc] of docs) {
  const name = f.split('/').pop(), text = E.writeGpx(doc), n = doc.points.length;
  const back = parseGpx(text);
  check(back.points.length === n && back.points.every((p, i) => Math.abs(p[0] - doc.points[i][0]) < 1e-6 && Math.abs(p[1] - doc.points[i][1]) < 1e-6), `${name}: track points read back identical`);
  check(back.name === doc.name, `${name}: route name kept (${back.name})`);
  check(!/<segment|<route>/.test(text) && /xmlns:osmand=/.test(text) && /creator="STS NAV cleaner"/.test(text), `${name}: no OsmAnd segment block, osmand namespace and creator present`);
  const rte = [...text.matchAll(/<rtept lat="([^"]+)" lon="([^"]+)">.*?<osmand:trkpt_idx>(\d+)<\/osmand:trkpt_idx>.*?<\/rtept>/g)].map((m) => [m[1], m[2], +m[3]]);
  const trk = [...text.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)"\/>/g)].map((m) => [m[1], m[2]]);
  const want = [...new Set([0, ...doc.route.maneuvers.filter((m) => m.kind !== 'arrive').map((m) => m.i), n - 1])].sort((a, b) => a - b);
  check(rte.length === want.length && rte.every((r, k) => r[2] === want[k]), `${name}: one planned point per maneuver plus start and end (${rte.length})`);
  check(rte[0][2] === 0 && rte[rte.length - 1][2] === n - 1 && rte.every((r, k) => k === 0 || r[2] > rte[k - 1][2]), `${name}: planned point indices start at 0, end at n-1, increase`);
  check(rte.every((r) => trk[r[2]] && trk[r[2]][0] === r[0] && trk[r[2]][1] === r[1]), `${name}: every planned point is the track point at its index, byte for byte`);
  check(/<osmand:profile>car<\/osmand:profile>/.test(text) && /<name>Planned point 1<\/name>/.test(text), `${name}: planned points carry the car profile and names`);
  const again = prepare(text, netDoc).route;
  check(again.X.length === n && uturnCount(again) === doc.uturns.length, `${name}: the app rebuilds the saved file to the same route (${again.X.length} vertices, ${uturnCount(again)} U-turns)`);
}
check(E.writeGpx(docs.get(heavy), { name: 'A & B <c>' }).includes('<name>A &amp; B &lt;c&gt;</name>'), 'names are XML-escaped');

/* T6: rerouting between two points follows legal streets and removes the U-turn in between */
section('T6 reroute');
{
  const doc = docs.get(heavy), r = doc.route, n = r.X.length;
  // picking vertices on the map
  const i = Math.floor(n / 2);
  check(E.nearestVertex(doc, r.X[i], r.Y[i]) === i || dist(r, E.nearestVertex(doc, r.X[i], r.Y[i]), i) < 0.5, 'nearestVertex finds the vertex under the cursor');
  check(E.nearestVertex(doc, r.X[i] + 500, r.Y[i] + 500, { tol: 15 }) === -1, 'nearestVertex returns -1 far from the route');
  const near = E.verticesNear(doc, r.X[i], r.Y[i], 15);
  check(near.length >= 1 && near[0].i === i && near.every((v, k) => k === 0 || v.d >= near[k - 1].d), 'verticesNear lists candidates nearest first');
  const jn = E.nearestVertex(doc, r.X[i], r.Y[i], { nodeOnly: true, tol: 60 });
  check(jn >= 0 && r.node[jn] >= 0, 'nearestVertex can ask for a street node');

  const u = doc.uturns.find((v) => v.type !== 'deadEnd');
  check(!!u, 'day has a U-turn that is not at a dead end');
  let iA = u.a; while (iA > 0 && (r.node[iA] < 0 || r.along[u.a] - r.along[iA] < 60)) iA--;
  let iB = u.b; while (iB < n - 1 && (r.node[iB] < 0 || r.along[iB] - r.along[u.b] < 60)) iB++;
  const before = { points: doc.points, n, total: r.total, uturns: doc.uturns.length };
  const pv = E.previewReroute(doc, iA, iB);
  check(!!pv && pv.points.length > 0, `preview finds a legal path (${iA} -> ${iB})`);
  check(doc.points === before.points && doc.history.length === 0, 'preview does not change the document');
  check(pv.uturnsInside.length === 0, 'no U-turn inside the new stretch');
  check(pv.legality.wrongWay.length === 0 && pv.legality.banned.length === 0 && pv.legality.offStreet < 0.5, 'new stretch is legal and on streets');
  check(pv.range.iA === iA && pv.range.iB > iA, 'preview reports the replaced range');
  check(E.previewReroute(doc, iA, iB, { maxCost: 10 }) === null, 'no path within a tiny budget');
  const res = E.reroute(doc, iA, iB);
  check(!!res && doc.history.length === 1, 'reroute commits one history entry');
  check(doc.points.slice(0, iA + 1).every((p, k) => p[0] === before.points[k][0] && p[1] === before.points[k][1]), 'route before A is untouched');
  const tail = before.n - 1 - iB;
  check(doc.points.slice(-tail).every((p, k) => { const q = before.points[before.n - tail + k]; return p[0] === q[0] && p[1] === q[1]; }), 'route after B is untouched');
  check(Math.abs(doc.route.total - before.total - res.deltaMeters) < 0.01, 'delta matches the new total');
  check(doc.uturns.length <= before.uturns - 1, `U-turns went down (${before.uturns} -> ${doc.uturns.length})`);
  console.log(`  reroute ${iA}->${iB}: ${res.deltaMeters.toFixed(0)} m, lost ${res.coverage.lostMeters.toFixed(0)} m, gained ${res.coverage.gainedMeters.toFixed(0)} m`);
  E.undo(doc);
  check(doc.points.length === before.n && !doc.dirty, 'undo restores the route');
}

/* T7: moving and deleting single vertices */
section('T7 movePoint / deletePoints');
{
  const doc = docs.get(heavy), r = doc.route, net = doc.net, n = r.X.length;
  // three street nodes in the middle of a block, all on mapped streets
  let i = -1;
  for (let k = 2; k < n - 4; k++) {
    if ([k, k + 1, k + 2].every((v) => r.node[v] >= 0 && net.deg[r.node[v]] === 2) && [k - 1, k, k + 1, k + 2].every((v) => r.half[v] >= 0)) { i = k; break; }
  }
  check(i > 0, 'found three mid-block vertices');
  const before = { n, total: r.total, points: doc.points };
  const del = E.deletePoints(doc, i, i + 2, { legal: false });
  check(!!del && Math.abs(del.deltaMeters) < 1, `plain delete refills along the same street (${del && del.deltaMeters.toFixed(2)} m)`);
  check(doc.points.length === before.n, 'the engine puts the street nodes back');
  check(del.legality.offStreet < 0.5, 'fill is on streets');
  E.undo(doc);
  const legal = E.deletePoints(doc, i, i + 2, { legal: true });
  check(!!legal && Math.abs(legal.deltaMeters) < 1 && doc.points.length === before.n, 'legal delete gives the same result on a straight block');
  E.undo(doc);
  check(E.deletePoints(doc, 0, n - 2) === null, 'cannot delete the whole route');

  // move a vertex 10 m sideways
  const j = i + 1, [la, lo] = doc.points[j];
  const [x, y] = doc.proj.toXY(la, lo), bx = (r.X[j + 1] - r.X[j - 1]), by = (r.Y[j + 1] - r.Y[j - 1]), L = Math.hypot(bx, by);
  const [sla, slo] = doc.proj.toLL(x - 10 * by / L, y + 10 * bx / L);
  const mv = E.movePoint(doc, j, sla, slo, { snap: true });
  check(!!mv && dist(doc.route, j, j) === 0 && Math.hypot(doc.route.X[j] - x, doc.route.Y[j] - y) < 0.5, 'snapped move returns to the street node');
  check(Math.abs(mv.deltaMeters) < 1 && mv.legality.offStreet < 0.5, 'snapped move leaves the route on the street');
  E.undo(doc);
  const raw = E.movePoint(doc, j, sla, slo, { snap: false });
  check(!!raw && raw.legality.offStreet > 5, `unsnapped move is reported off the street (${raw && raw.legality.offStreet.toFixed(1)} m)`);
  check(Math.hypot(doc.route.X[j] - x, doc.route.Y[j] - y) > 9, 'unsnapped vertex stays where it was dropped');
  E.undo(doc);
  check(doc.points === before.points || doc.points.every((p, k) => p[0] === before.points[k][0] && p[1] === before.points[k][1]), 'undo restores the route');
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
