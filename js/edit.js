// Route cleaning: a route document that can be inspected and edited, and written back as GPX.
// No DOM here; the same code runs in the browser page (cleaner/) and in Node (tests/edit_test.mjs).
//
// The document is the list of route vertices as the engine snapped them to the streets
// (lat/lon, 6 decimals). Rebuilding a route from its own vertices gives the same route back
// (a fixed point, checked by the tests), so every edit is: make a new vertex list, rebuild.
import { prepare, buildRoute, detectManeuvers, findWayBack } from './core.js';

const round6 = (v) => Math.round(v * 1e6) / 1e6;

/* ------------------------------------------------------------------ document */

export function openDoc(gpxText, netDoc, { file = '' } = {}) {
  const { gpx, proj, net, route } = prepare(gpxText, netDoc);
  if (!net) throw new Error('no-network');
  const doc = {
    file, name: gpx.name || '', net, proj,
    points: pointsOf(route),
    route: null, cov: null, uturns: [], grid: null,
    history: [], future: [], dirty: false, savedPoints: null, home: null, original: null,
  };
  rebuild(doc);
  doc.home = doc.points[0].slice();
  doc.savedPoints = doc.points;
  doc.original = { points: doc.points, total: doc.route.total, uturnCount: uturnsOf(doc.route).length };
  return doc;
}

export function rebuild(doc) {
  const route = buildRoute({ name: doc.name, points: doc.points }, doc.net, doc.proj);
  route.maneuvers = detectManeuvers(route, doc.net);
  if (route.X.length !== doc.points.length) {               // not a fixed point (should not happen): adopt the engine's vertices
    doc.adopted = (doc.adopted || 0) + 1;
    doc.points = pointsOf(route);
    return rebuild(doc);
  }
  doc.route = route;
  doc.cov = coverageTable(route, doc.net);
  doc.uturns = analyzeUturns(doc);
  doc.grid = vertexGrid(route);
  return doc;
}

/* ------------------------------------------------------------------ finding vertices */

const CELL = 25;                                                  // metres
const cellKey = (cx, cy) => (cx + 32768) * 65536 + (cy + 32768);

function vertexGrid(route) {
  const g = new Map();
  for (let i = 0; i < route.X.length; i++) {
    const k = cellKey(Math.floor(route.X[i] / CELL), Math.floor(route.Y[i] / CELL));
    const l = g.get(k); if (l) l.push(i); else g.set(k, [i]);
  }
  return g;
}

// Route vertices within tol metres of a map position, nearest first
export function verticesNear(doc, x, y, tol = 15) {
  const { route, grid } = doc, out = [];
  const c0x = Math.floor((x - tol) / CELL), c1x = Math.floor((x + tol) / CELL), c0y = Math.floor((y - tol) / CELL), c1y = Math.floor((y + tol) / CELL);
  for (let cx = c0x; cx <= c1x; cx++) for (let cy = c0y; cy <= c1y; cy++) {
    const l = grid.get(cellKey(cx, cy));
    if (!l) continue;
    for (const i of l) { const d = Math.hypot(route.X[i] - x, route.Y[i] - y); if (d <= tol) out.push({ i, d }); }
  }
  return out.sort((p, q) => p.d - q.d);
}

export function nearestVertex(doc, x, y, { after = -1, nodeOnly = false, tol = 15 } = {}) {
  for (const { i } of verticesNear(doc, x, y, tol)) {
    if (i <= after) continue;
    if (nodeOnly && doc.route.node[i] < 0) continue;
    return i;
  }
  return -1;
}

const pointsOf = (route) => Array.from(route.lat, (la, i) => [round6(la), round6(route.lon[i])]);
const uturnsOf = (route) => route.maneuvers.filter((m) => m.kind === 'uturn');

/* ------------------------------------------------------------------ streets driven */

// Maximal stretches of the route on one half-edge (a GPX vertex in the middle of a street piece
// splits it into two route segments; the runs join them again). h is -1 off the street map.
export function halfRuns(route) {
  const H = route.half, runs = [];
  for (let i = 0; i < H.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.h === H[i]) last.i1 = i + 1;
    else runs.push({ h: H[i], i0: i, i1: i + 1 });
  }
  return runs;
}

// How many times the route drives each street segment (either direction unless `directed`)
export function coverageTable(route, net, { directed = false } = {}) {
  const cov = new Uint16Array(directed ? net.segCount * 2 : net.segCount);
  for (const h of route.half) if (h >= 0) cov[directed ? h : h >> 1]++;
  return cov;
}

// What would no longer be driven anywhere if vertices a..b were cut out of the route
export function verdictForRange(doc, a, b) {
  const { route, net, cov } = doc, inside = new Map();
  for (let i = a; i < b; i++) { const h = route.half[i]; if (h >= 0) inside.set(h >> 1, (inside.get(h >> 1) || 0) + 1); }
  const lost = [];
  for (const [s, n] of inside) {
    if (cov[s] - n > 0) continue;
    lost.push({ s, name: net.nameOf(net.sW[s]) || '(no name)', meters: net.sLen[s] });
  }
  const lostMeters = lost.reduce((t, l) => t + l.meters, 0);
  return { ok: lostMeters < 1, lostMeters, lost };
}

/* ------------------------------------------------------------------ U-turns */

// The stretch the route drives out and straight back around apex i: vertices a..b, with the
// route retracing itself K half-edges deep. K = 0: the route turns round without retracing.
export function spurExtent(route, i) {
  const runs = halfRuns(route);
  let r = -1;
  for (let k = 0; k < runs.length; k++) if (runs[k].i1 === i) { r = k; break; }
  let K = 0;
  while (r - K >= 0 && r + 1 + K < runs.length && runs[r - K].h >= 0 && runs[r + 1 + K].h === (runs[r - K].h ^ 1)) K++;
  if (K === 0) return { a: i, b: i, K: 0, partial: false };
  const a = runs[r - K + 1].i0, b = runs[r + K].i1;
  return { a, b, K, partial: Math.hypot(route.X[a] - route.X[b], route.Y[a] - route.Y[b]) > 0.5 };
}

export function analyzeUturns(doc) {
  const { route, net } = doc, out = [];
  uturnsOf(route).forEach((m, k) => {
    const i = m.i;
    let ext, type;
    if (m.mergedTo != null) {                                 // two sharp turns through a gap in a divided road
      ext = { a: i, b: m.mergedTo, K: 0, partial: false }; type = 'midStreet';
    } else {
      ext = spurExtent(route, i);
      const nd = route.node[i], retrace = ext.K > 0;
      type = retrace && nd >= 0 && net.deg[nd] === 1 ? 'deadEnd' : retrace && nd >= 0 ? 'spur' : 'midStreet';
    }
    out.push({
      k, i, along: route.along[i], type, ...ext,
      spurMeters: route.along[i] - route.along[ext.a], loopMeters: route.along[ext.b] - route.along[ext.a],
      name: m.name || '', mergedTo: m.mergedTo, lat: route.lat[i], lon: route.lon[i],
      verdict: verdictForRange(doc, ext.a, ext.b),
    });
  });
  return out;
}

/* ------------------------------------------------------------------ edits */

const samePoints = (a, b) => a === b || (a.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]));
const km = (m) => (m / 1000).toFixed(2) + ' km';

// Streets the new route no longer drives at all, and streets it drives for the first time
export function coverageDiff(oldRoute, newRoute, net) {
  const a = coverageTable(oldRoute, net), b = coverageTable(newRoute, net);
  const lost = [], gained = [];
  for (let s = 0; s < a.length; s++) {
    if (a[s] && !b[s]) lost.push({ s, name: net.nameOf(net.sW[s]) || '(no name)', meters: net.sLen[s] });
    else if (!a[s] && b[s]) gained.push({ s, name: net.nameOf(net.sW[s]) || '(no name)', meters: net.sLen[s] });
  }
  const sum = (l) => l.reduce((t, x) => t + x.meters, 0);
  return { lost, gained, lostMeters: sum(lost), gainedMeters: sum(gained) };
}

// Replace the vertex list, remember the old one for undo, rebuild, and describe what changed
export function commit(doc, label, newPoints, extra = {}) {
  const oldRoute = doc.route, oldUturns = doc.uturns.length;
  doc.history.push({ label, points: doc.points });
  doc.future.length = 0;
  doc.points = newPoints;
  rebuild(doc);
  doc.dirty = !samePoints(doc.points, doc.savedPoints);
  return {
    label, deltaMeters: doc.route.total - oldRoute.total,
    uturnsBefore: oldUturns, uturnsAfter: doc.uturns.length,
    coverage: coverageDiff(oldRoute, doc.route, doc.net), ...extra,
  };
}

export function undo(doc) {
  const h = doc.history.pop();
  if (!h) return false;
  doc.future.push({ label: h.label, points: doc.points });
  doc.points = h.points;
  rebuild(doc);
  doc.dirty = !samePoints(doc.points, doc.savedPoints);
  return true;
}

export function redo(doc) {
  const f = doc.future.pop();
  if (!f) return false;
  doc.history.push({ label: f.label, points: doc.points });
  doc.points = f.points;
  rebuild(doc);
  doc.dirty = !samePoints(doc.points, doc.savedPoints);
  return true;
}

// Remove the out-and-back stretch of a U-turn: the route goes on from where it left the spur
export function cutSpur(doc, u) {
  if (!u || !(u.K > 0) || u.b <= u.a) return null;
  const { route, net } = doc;
  const newPoints = doc.points.slice(0, u.a + 1).concat(doc.points.slice(u.b));
  const hIn = u.a > 0 ? route.half[u.a - 1] : -1, hOut = u.b < route.half.length ? route.half[u.b] : -1;
  const seam = { banned: hIn >= 0 && hOut >= 0 && net.banned(hIn, hOut) };
  return commit(doc, `cut spur at ${km(u.along)}${u.name ? ' (' + u.name + ')' : ''}`, newPoints, { seam, range: { iA: u.a, iB: u.a } });
}

/* ------------------------------------------------------------------ legality */

// Same checks as tests/plan_check.mjs, for vertices i0..i1 of a route
export function legality(route, net, i0 = 0, i1 = route.X.length - 1) {
  const wrongWay = [], banned = [];
  let offStreet = 0;
  const a0 = Math.max(0, i0), a1 = Math.min(route.half.length, i1);
  for (let i = a0; i < a1; i++) {
    const h = route.half[i], L = route.along[i + 1] - route.along[i];
    if (h < 0) { offStreet += L; continue; }
    if (!net.allowed(h)) wrongWay.push({ i, meters: L, name: net.nameOf(net.way(h)) || '(no name)' });
    if (i > 0 && route.half[i - 1] >= 0 && route.half[i - 1] !== h && net.head(route.half[i - 1]) === net.tail(h) && net.banned(route.half[i - 1], h)) {
      banned.push({ i, from: net.nameOf(net.way(route.half[i - 1])) || '(no name)', to: net.nameOf(net.way(h)) || '(no name)' });
    }
  }
  return { wrongWay, banned, offStreet };
}

/* ------------------------------------------------------------------ rerouting */

// A planned route should not turn round in the street: a long way round the block is better,
// and it should keep to real streets (same settings as tools/make_route.mjs)
const PLAN = { maxCost: 80000, uturn: { street: 5000, deadEnd: 3000 }, avoid: { service: 8, minor: 12 } };

// Legal path along the streets from vertex iFrom (arriving the way the route arrives there)
// to vertex iTo (leaving the way the route leaves). Both are moved to street nodes first.
export function legalPath(doc, iFrom, iTo, opts = {}) {
  const { route, net, proj } = doc, n = route.X.length, o = { ...PLAN, ...opts };
  let iA = Math.max(0, Math.min(iFrom, n - 1)), iB = Math.max(0, Math.min(iTo, n - 1));
  // A must be a street node the car can drive on from (not the apex of a turn-back, not on a piece
  // the planner should not have used); B a street node whose next piece is drivable
  const apex = (i) => i > 0 && i < n - 1 && route.half[i - 1] >= 0 && route.half[i] === (route.half[i - 1] ^ 1);
  const badA = (i) => route.node[i] < 0 || apex(i) || (i > 0 && (route.half[i - 1] < 0 || !net.allowed(route.half[i - 1])));
  const badB = (i) => route.node[i] < 0 || apex(i) || (i < n - 1 && (route.half[i] < 0 || !net.allowed(route.half[i])));
  while (iA > 0 && badA(iA)) iA--;
  while (iB < n - 1 && badB(iB)) iB++;
  if (iB <= iA) return null;
  let starts;
  if (iA > 0 && route.half[iA - 1] >= 0) starts = [{ h: route.half[iA - 1], remain: 0, x: route.X[iA], y: route.Y[iA] }];
  else {
    const nd = route.node[iA]; starts = [];
    for (let k = net.adjStart[nd]; k < net.adjStart[nd + 1]; k++) { const h = net.adj[k]; if (net.allowed(h)) starts.push({ h, remain: net.sLen[h >> 1], x: route.X[iA], y: route.Y[iA] }); }
    if (!starts.length) return null;
  }
  const hGoal = iB < n - 1 ? route.half[iB] : route.half[iB - 1];
  if (hGoal < 0) return null;
  const goals = new Map([[hGoal, { extra: 0 }]]);
  const path = findWayBack(net, proj, null, null, goals, o.maxCost, starts, o.uturn, o.avoid);
  if (!path) return null;
  // the path runs from A to the far end of the goal half; when B is the tail of that half, stop at B
  let pts = pointsOf(path);
  if (iB < n - 1) pts = pts.slice(0, -1);
  return { iA, iB, path, points: pts };
}

export function previewReroute(doc, iA, iB, opts = {}) {
  const lp = legalPath(doc, iA, iB, opts);
  if (!lp) return null;
  const { route, net } = doc, n = route.X.length;
  const points = doc.points.slice(0, lp.iA + 1).concat(lp.points, doc.points.slice(lp.iB));
  const scratch = buildRoute({ name: doc.name, points }, net, doc.proj);
  scratch.maneuvers = detectManeuvers(scratch, net);
  const newB = scratch.X.length - (n - lp.iB);                      // the suffix is unchanged
  const uturnsInside = uturnsOf(scratch).filter((m) => m.i > lp.iA && m.i < newB);
  return {
    points: pointsOf(scratch), path: lp.path, range: { iA: lp.iA, iB: newB },
    deltaMeters: scratch.total - route.total, coverage: coverageDiff(route, scratch, net),
    uturnsInside, legality: legality(scratch, net, lp.iA, newB),
    uturnsBefore: doc.uturns.length, uturnsAfter: uturnsOf(scratch).length,
  };
}

export function reroute(doc, iA, iB, opts = {}) {
  const pv = previewReroute(doc, iA, iB, opts);
  if (!pv) return null;
  const r = doc.route;
  return commit(doc, `reroute ${km(r.along[pv.range.iA])} → ${km(r.along[Math.min(iB, r.X.length - 1)])}`, pv.points,
    { range: pv.range, legality: pv.legality, uturnsInside: pv.uturnsInside });
}

/* ------------------------------------------------------------------ single points */

// Move vertex i; by default it lands on the nearest street (node within 8 m, else street within 30 m)
export function movePoint(doc, i, lat, lon, { snap = true } = {}) {
  const { net, proj, route } = doc;
  if (i < 0 || i >= doc.points.length) return null;
  let [x, y] = proj.toXY(lat, lon);
  if (snap) { const q = net.snap(x, y, 8, 30); if (q) { x = q.x; y = q.y; } }
  const [la, lo] = proj.toLL(x, y);
  const points = doc.points.slice();
  points[i] = [round6(la), round6(lo)];
  const res = commit(doc, `move point at ${km(route.along[i])}`, points, { range: { iA: i, iB: i } });
  res.legality = legality(doc.route, net, Math.max(0, i - 1), Math.min(doc.route.X.length - 1, i + 1));
  return res;
}

// Delete vertices i0..i1 (never the first or last). The gap is filled along the streets:
// legally (no wrong-way, no banned turn, no U-turn) or, with legal=false, by the shortest path.
export function deletePoints(doc, i0, i1, { legal = true } = {}) {
  const n = doc.points.length, { net, route } = doc;
  const a = Math.max(1, Math.min(i0, i1)), b = Math.min(n - 2, Math.max(i0, i1));
  if (b < a) return null;
  if (legal) {
    const res = reroute(doc, a - 1, b + 1);
    if (res) res.label = `delete points ${a}–${b} (${km(route.along[a])})`;
    return res;
  }
  const points = doc.points.slice(0, a).concat(doc.points.slice(b + 1));
  const res = commit(doc, `delete points ${a}–${b} (${km(route.along[a])})`, points, { range: { iA: a - 1, iB: a } });
  const newB = doc.route.X.length - (n - 1 - b);
  res.range.iB = newB;
  res.legality = legality(doc.route, net, a - 1, newB);
  return res;
}

/* ------------------------------------------------------------------ GPX out */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f6 = (v) => v.toFixed(6);

// The file the phone drives: planned points at the start, every instruction and the end
// (each tied to its track point, as the planner's files do), then the track itself.
// `route` and `points` can be given separately so that part of a document can be written too.
export function writeGpx(doc, { name = doc.name, route = doc.route, points = doc.points } = {}) {
  const n = points.length;
  const idx = [...new Set([0, ...route.maneuvers.filter((m) => m.kind !== 'arrive').map((m) => m.i), n - 1])].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n';
  out += '<gpx version="1.1" creator="STS NAV cleaner" xmlns="http://www.topografix.com/GPX/1/1" xmlns:osmand="https://osmand.net">\n';
  out += `<rte><name>${esc(name)}</name>\n`;
  idx.forEach((i, k) => {
    out += `<rtept lat="${f6(points[i][0])}" lon="${f6(points[i][1])}"><name>Planned point ${k + 1}</name>` +
      `<extensions><osmand:profile>car</osmand:profile><osmand:trkpt_idx>${i}</osmand:trkpt_idx></extensions></rtept>\n`;
  });
  out += '</rte>\n';
  out += `<trk><name>${esc(name)} (navigation)</name><trkseg>\n`;
  for (const [la, lo] of points) out += `<trkpt lat="${f6(la)}" lon="${f6(lo)}"/>\n`;
  out += '</trkseg></trk>\n</gpx>\n';
  return out;
}

/* ------------------------------------------------------------------ names */

export function cleanName(file) {
  return file.replace(/(_clean)?\.gpx$/i, '') + '_clean.gpx';
}
