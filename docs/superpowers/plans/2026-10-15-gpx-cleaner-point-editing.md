# Route Cleaner Point Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user shorten a spur to any point, delete points with the gap simply closed along the street, insert and drag points, and find points easily in the route cleaner.

**Architecture:** All route logic goes into the DOM-free module `js/edit.js` and is tested in Node against the real day files (`tests/edit_test.mjs`, plain `check()` script, no framework). The page `cleaner/cleaner.js` only maps clicks and hovers to those functions and redraws. The document is the list of street-snapped vertices; every edit is a new vertex list plus `commit()` which rebuilds the route through `core.js`.

**Tech Stack:** Vanilla ES modules, Node ≥ 22 for tests, MapLibre GL 4.7.1 (vendored), no build step, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-15-gpx-cleaner-point-editing-design.md` (and the base design `docs/superpowers/specs/2026-10-14-gpx-cleaner-design.md`).

## Global Constraints

- No new dependencies; no build step; the cleaner is served by `node tools/cleaner_server.mjs 8791` from the repo root.
- `js/core.js`, the driver app, `sw.js` and `js/days.js` stay untouched.
- Every engine function is exported from `js/edit.js` and exercised by `tests/edit_test.mjs` on the real file `data/routes/day_01_nav.gpx` with `data/tbilisi-net.json`.
- Run tests from the worktree root: `node tests/edit_test.mjs data/routes/day_01_nav.gpx` (one file, ~10 s) and `node tests/edit_test.mjs` (all files, ~60 s) before each commit.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01YNRNiv22cacjg4SmM6iVK3`.
- Do not commit `data/routes/*_clean.gpx` (the user's saved work).
- Coordinates in the document are `[lat, lon]` rounded to 6 decimals (`round6` in edit.js); map positions are metres `(x, y)` from `doc.proj.toXY(lat, lon)`.

## Review Focus

1. Trim click exactly on the apex vertex of a spur: must do nothing and say so, never crash or produce an empty stretch. Pinned in Task 1 (null result) and Task 5 (toast).
2. Trim on a *partial* spur (the return leg ends mid-block, `u.partial === true`): the mirror vertex may be a few metres off; the result must still rebuild as a fixed point with the U-turn at the trim point. Pinned in Task 1.
3. Delete of the vertex right after the start or right before the end (index 1 or n−2) must work; index 0 / n−1 are kept. Pinned in Task 2.
4. Insert where the cursor is near two passes of the route: the segment chosen is the nearest one, and the new point lands on that pass only; the other pass keeps its vertex count. Pinned in Task 3.
5. Move of a vertex that shares its spot with another pass must move only the picked index; the other pass is unchanged. Pinned in Task 4.

---

### Task 1: `trimSpur` and `mirrorVertex` (engine)

**Files:**
- Modify: `js/edit.js` (add after `cutSpur`, around line 213)
- Test: `tests/edit_test.mjs` (add section T9 before the final `console.log` of totals)

**Interfaces:**
- Consumes: `cutSpur(doc, u)`, `commit(doc, label, newPoints, extra)`, `km(m)` (all already in `js/edit.js`); `doc.uturns[k]` items `{ k, i, a, b, K, partial, along, name }` from `analyzeUturns`.
- Produces: `export function mirrorVertex(route, i, lo, hi) → number` (vertex index in `lo..hi` nearest to vertex `i`, or −1 when `lo > hi`); `export function trimSpur(doc, u, i) → EditResult | null` where `EditResult = { label, deltaMeters, uturnsBefore, uturnsAfter, coverage, range: { iA, iB } }` (same shape `cutSpur` returns). `i` may lie on the way out (`u.a ≤ i < u.i`) or on the way back (`u.i < i ≤ u.b`); `i === u.i` → null; `i === u.a` (or its mirror `u.b`) → identical to `cutSpur`.

- [ ] **Step 1: Write the failing tests**

Append before the line `console.log(\`\n${passes} passed, ${failures} failed\`);` in `tests/edit_test.mjs`:

```js
/* T9: trimming a spur keeps the way out to a chosen point and turns back there */
section('T9 trimSpur');
{
  const doc = docs.get(heavy), r = doc.route, n = r.X.length;
  const u = doc.uturns.find((v) => v.type === 'deadEnd' && !v.partial && v.i - v.a >= 3);
  check(!!u, 'a full dead-end spur with at least three vertices on the way out');
  const t = u.a + Math.floor((u.i - u.a) / 2);
  const m = E.mirrorVertex(r, t, u.i + 1, u.b);
  check(m > u.i && m <= u.b && dist(r, t, m) < 1, `mirror of vertex ${t} is the same spot on the way back (${m})`);
  check(E.mirrorVertex(r, t, 5, 4) === -1, 'empty range has no mirror');
  const before = { n, total: r.total, uturns: doc.uturns.length, points: doc.points };
  const res = E.trimSpur(doc, u, t);
  check(!!res && doc.points.length === before.n - (m - t), `the stretch beyond the trim point is gone (${doc.points.length} vs ${before.n - (m - t)})`);
  check(Math.abs(res.deltaMeters + (r.along[m] - r.along[t])) < 1, `length drops by the trimmed out-and-back (${res.deltaMeters.toFixed(1)} m)`);
  check(doc.uturns.length <= before.uturns && doc.uturns.some((v) => v.i === t), 'the U-turn now sits at the trim point');
  check(doc.points.slice(0, t + 1).every((p, k) => p[0] === before.points[k][0] && p[1] === before.points[k][1]), 'route up to the trim point is untouched');
  check(res.label.includes('trim') && res.range.iA === t, 'result is labelled and reports the trim point');
  E.undo(doc);
  const res2 = E.trimSpur(doc, u, m);
  check(!!res2 && Math.abs(res2.deltaMeters - res.deltaMeters) < 0.01 && doc.points.length === before.n - (m - t), 'trimming from the way back gives the same result');
  E.undo(doc);
  const cut = E.cutSpur(doc, u), cutDelta = cut.deltaMeters;
  E.undo(doc);
  const res3 = E.trimSpur(doc, u, u.a);
  check(!!res3 && Math.abs(res3.deltaMeters - cutDelta) < 0.01, 'trimming at the base equals cutting the spur');
  E.undo(doc);
  check(E.trimSpur(doc, u, u.i) === null, 'no trim at the apex');
  check(E.trimSpur(doc, { ...u, K: 0 }, t) === null, 'no trim without a spur');
  check(E.trimSpur(doc, u, u.b + 5) === null, 'no trim outside the spur');
  check(doc.points.length === before.n && !doc.dirty, 'nothing left behind');

  // a partial spur (the way back ends mid-block): the mirror is a little off but the trim still works
  const pu = doc.uturns.find((v) => v.type !== 'midStreet' && v.partial && v.i - v.a >= 3);
  if (pu) {
    const pt = pu.a + Math.floor((pu.i - pu.a) / 2);
    const pres = E.trimSpur(doc, pu, pt);
    check(!!pres && doc.route.X.length === doc.points.length && doc.uturns.some((v) => Math.abs(v.i - pt) <= 1), 'partial spur trims to a valid route with the U-turn at the trim point');
    E.undo(doc);
  } else console.log('  (no partial spur on this file)');
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/edit_test.mjs data/routes/day_01_nav.gpx 2>&1 | grep -E "FAIL|Error|passed"`
Expected: `TypeError: E.mirrorVertex is not a function`

- [ ] **Step 3: Implement `mirrorVertex` and `trimSpur`**

Insert after the closing brace of `cutSpur` in `js/edit.js`:

```js
// The vertex between lo and hi nearest to vertex i: the same spot on the other leg of a spur
export function mirrorVertex(route, i, lo, hi) {
  let best = -1, bd = Infinity;
  for (let k = lo; k <= hi; k++) {
    const d = Math.hypot(route.X[k] - route.X[i], route.Y[k] - route.Y[i]);
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

// Shorten the out-and-back of U-turn u: the car turns back at vertex i instead of at the apex.
// i may be on the way out (a <= i < apex) or on the way back (apex < i <= b); both give the same route.
export function trimSpur(doc, u, i) {
  if (!u || !(u.K > 0) || u.b <= u.a) return null;
  if (i < u.a || i > u.b || i === u.i) return null;
  const { route } = doc;
  let t, m;
  if (i < u.i) { t = i; m = mirrorVertex(route, i, u.i + 1, u.b); }
  else { m = i; t = mirrorVertex(route, i, u.a, u.i - 1); }
  if (t <= u.a) return cutSpur(doc, u);
  if (m <= t) return null;
  const newPoints = doc.points.slice(0, t + 1).concat(doc.points.slice(m));
  return commit(doc, `trim spur at ${km(u.along)} back to ${km(route.along[t])}${u.name ? ' (' + u.name + ')' : ''}`, newPoints, { range: { iA: t, iB: t } });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/edit_test.mjs data/routes/day_01_nav.gpx 2>&1 | grep -E "FAIL|Error|passed"`
Expected: `… passed, 0 failed` (no FAIL lines). If "a full dead-end spur with at least three vertices" fails, day 1 has none with that shape; relax `v.i - v.a >= 3` to `>= 2` in both the test and the mid-point formula and rerun.

- [ ] **Step 5: Commit**

```bash
git add js/edit.js tests/edit_test.mjs
git commit -m "Cleaner engine: trimSpur turns back at a chosen vertex of a spur

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YNRNiv22cacjg4SmM6iVK3"
```

---

### Task 2: `deletePoints` closes the gap along the street by default (engine)

**Files:**
- Modify: `js/edit.js:311-328` (`deletePoints`)
- Test: `tests/edit_test.mjs` section `T7 movePoint / deletePoints`

**Interfaces:**
- Produces: `deletePoints(doc, i0, i1, { legal = false } = {})` — same return as before. With `legal: true` the gap is filled by `reroute()` (legal detour); by default the vertices are spliced out and the engine's own shortest street path joins the neighbours.

- [ ] **Step 1: Write the failing test**

In section T7 of `tests/edit_test.mjs`, replace the line

```js
  const del = E.deletePoints(doc, i, i + 2, { legal: false });
```

with

```js
  const del = E.deletePoints(doc, i, i + 2);                       // default: just close the gap along the street
```

and add right after the existing line `check(E.deletePoints(doc, 0, n - 2) === null, 'cannot delete the whole route');`:

```js
  const edge = E.deletePoints(doc, 1, 1);
  check(!!edge && doc.points.length <= n && doc.points[0][0] === before.points[0][0] && doc.points[0][1] === before.points[0][1], 'the vertex after the start can be deleted; the start stays');
  E.undo(doc);
  const tail = E.deletePoints(doc, n - 2, n - 2);
  check(!!tail && doc.points[doc.points.length - 1][0] === before.points[n - 1][0] && doc.points[doc.points.length - 1][1] === before.points[n - 1][1], 'the vertex before the end can be deleted; the end stays');
  E.undo(doc);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/edit_test.mjs data/routes/day_01_nav.gpx 2>&1 | grep -E "FAIL|Error|passed"`
Expected: `FAIL plain delete refills along the same street (…)` is **not** guaranteed to fail (the legal detour on a straight block is also ~0 m), so verify the default by reading: `grep -n "legal = true" js/edit.js` prints the `deletePoints` line. The two new edge checks pass already; they pin behaviour.

- [ ] **Step 3: Change the default and the comment**

In `js/edit.js` replace

```js
// Delete vertices i0..i1 (never the first or last). The gap is filled along the streets:
// legally (no wrong-way, no banned turn, no U-turn) or, with legal=false, by the shortest path.
export function deletePoints(doc, i0, i1, { legal = true } = {}) {
```

with

```js
// Delete vertices i0..i1 (never the first or last). The neighbours are joined by the shortest path
// along the streets (on one street: that street; at the end of a spur: a turn-back there).
// With legal=true the gap is filled by a legal detour instead (no wrong-way, no banned turn, no U-turn).
export function deletePoints(doc, i0, i1, { legal = false } = {}) {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/edit_test.mjs data/routes/day_01_nav.gpx 2>&1 | grep -E "FAIL|Error|passed"`
Expected: `… passed, 0 failed`; `grep -n "legal = false" js/edit.js` shows the `deletePoints` signature.

- [ ] **Step 5: Commit**

```bash
git add js/edit.js tests/edit_test.mjs
git commit -m "Cleaner engine: deleting points closes the gap along the street by default

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YNRNiv22cacjg4SmM6iVK3"
```

---

### Task 3: `nearestSegment` and `insertPoint` (engine)

**Files:**
- Modify: `js/edit.js` (add `nearestSegment` after `nearestVertex` ~line 77; add `insertPoint` after `movePoint` ~line 309)
- Test: `tests/edit_test.mjs` (new section T10 before the totals line)

**Interfaces:**
- Consumes: `verticesNear(doc, x, y, tol)`, `nearestVertex(doc, x, y, { tol })`, `commit`, `legality`, `round6`, `net.snap(x, y, nodeTol, segTol)` from `core.js` (returns `{ node, x, y }`, `{ node: -1, s, t, x, y }` or `null`).
- Produces:
  - `export const SNAP_RADIUS = 60` (metres; used by `movePoint` in Task 4 too).
  - `export function nearestSegment(doc, x, y, tol = 15, reach = 200) → { i, t, x, y, d } | null` — route piece `i → i+1` under the cursor (`t` in 0..1 along it, `x,y` the foot point, `d` the distance). Only pieces with an endpoint within `reach` metres are considered.
  - `export function insertPoint(doc, i, lat, lon, { snap = true } = {}) → EditResult | null` — new vertex after vertex `i`, snapped to the nearest street within `SNAP_RADIUS` (node within 8 m preferred). Result has `index` (where the new vertex is after the rebuild), `range: { iA: i, iB: index + 1 }`, `legality` for that range.

- [ ] **Step 1: Write the failing tests**

Append before the totals line of `tests/edit_test.mjs`:

```js
/* T10: a point can be added on a route piece and lands where the cursor was */
section('T10 nearestSegment / insertPoint');
{
  const doc = docs.get(heavy), r = doc.route, net = doc.net, n = r.X.length;
  let s = -1;
  for (let k = 1; k < n - 2; k++) if (r.half[k] >= 0 && r.along[k + 1] - r.along[k] > 40 && r.node[k] >= 0 && r.node[k + 1] >= 0) { s = k; break; }
  check(s > 0, 'found a street piece longer than 40 m between two street nodes');
  const mx = (r.X[s] + r.X[s + 1]) / 2, my = (r.Y[s] + r.Y[s + 1]) / 2;
  const bx = r.X[s + 1] - r.X[s], by = r.Y[s + 1] - r.Y[s], L = Math.hypot(bx, by);
  const seg = E.nearestSegment(doc, mx - 2 * by / L, my + 2 * bx / L, 15);
  check(!!seg && seg.i === s && Math.abs(seg.d - 2) < 0.1 && Math.abs(seg.t - 0.5) < 0.05, `nearestSegment finds the piece 2 m beside its middle (${seg && seg.i} vs ${s})`);
  check(E.nearestSegment(doc, mx + 500, my + 500, 15) === null, 'nearestSegment returns null far from the route');
  check(E.SNAP_RADIUS === 60, 'snap radius is 60 m');
  const before = { n, total: r.total, points: doc.points };
  const [la, lo] = doc.proj.toLL(seg.x, seg.y);
  const res = E.insertPoint(doc, seg.i, la, lo);
  check(!!res && doc.points.length === before.n + 1 && Math.abs(res.deltaMeters) < 0.5, `a point on the piece adds one vertex and no length (${doc.points.length} vs ${before.n + 1}, ${res && res.deltaMeters.toFixed(2)} m)`);
  check(res.index === s + 1 && Math.hypot(doc.route.X[res.index] - seg.x, doc.route.Y[res.index] - seg.y) < 0.5, 'result reports where the new point landed');
  check(res.range.iA === s && res.range.iB === res.index + 1 && res.legality.offStreet < 0.5, 'range and legality cover the new piece');
  check(doc.dirty && doc.history.length === 1, 'insert is one undoable edit');
  E.undo(doc);
  check(doc.points.length === before.n, 'undo removes the point again');
  // 150 m beside the street without snapping: the route jumps straight there and back, off the map
  const [fla, flo] = doc.proj.toLL(mx - 150 * by / L, my + 150 * bx / L);
  const far = E.insertPoint(doc, s, fla, flo, { snap: false });
  check(!!far && far.legality.offStreet > 100, `an unsnapped point far from any street is reported off the map (${far && far.legality.offStreet.toFixed(0)} m)`);
  E.undo(doc);
  // with snapping, the same cursor position lands on some street within 60 m (if any), never off the map by 150 m
  const snapped = E.insertPoint(doc, s, fla, flo);
  const onStreet = !!net.snap(doc.route.X[snapped.index], doc.route.Y[snapped.index], 1.2, 4);
  check(!!snapped && (onStreet || snapped.legality.offStreet > 100), 'a snapped point lies on a street when one is within reach');
  E.undo(doc);
  // near two passes of the route the nearest piece wins and the other pass keeps its vertices
  let twice = -1;
  for (let k = 1; k < n - 1 && twice < 0; k++) { const near = E.verticesNear(doc, r.X[k], r.Y[k], 0.5); if (near.length > 1) twice = k; }
  if (twice > 0) {
    const other = E.verticesNear(doc, r.X[twice], r.Y[twice], 0.5).map((v) => v.i).filter((v) => v !== twice);
    const seg2 = E.nearestSegment(doc, (r.X[twice] + r.X[twice + 1]) / 2, (r.Y[twice] + r.Y[twice + 1]) / 2, 15);
    const [la2, lo2] = doc.proj.toLL(seg2.x, seg2.y);
    const ins = E.insertPoint(doc, seg2.i, la2, lo2);
    const otherAfter = other.map((v) => (v > seg2.i ? v + 1 : v));
    check(!!ins && otherAfter.every((v) => Math.abs(doc.route.X[v] - r.X[twice]) < 0.5 && Math.abs(doc.route.Y[v] - r.Y[twice]) < 0.5), 'inserting beside a shared spot touches only one pass');
    E.undo(doc);
  } else console.log('  (no shared spot found)');
  check(E.insertPoint(doc, n - 1, la, lo) === null && E.insertPoint(doc, -1, la, lo) === null, 'cannot insert after the last vertex or before the first');
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/edit_test.mjs data/routes/day_01_nav.gpx 2>&1 | grep -E "FAIL|Error|passed"`
Expected: `TypeError: E.nearestSegment is not a function`

- [ ] **Step 3: Implement**

In `js/edit.js`, after `nearestVertex` add:

```js
export const SNAP_RADIUS = 60;                                     // metres: how far a moved or added point may be from a street

function projectOnSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L2));
  const x = x1 + t * dx, y = y1 + t * dy;
  return { t, x, y, d: Math.hypot(px - x, py - y) };
}

// The route piece i -> i+1 under a map position (pieces with an end within `reach` metres are tried)
export function nearestSegment(doc, x, y, tol = 15, reach = 200) {
  const r = doc.route, seen = new Set();
  let best = null;
  for (const { i } of verticesNear(doc, x, y, reach)) {
    for (const s of [i - 1, i]) {
      if (s < 0 || s >= r.X.length - 1 || seen.has(s)) continue;
      seen.add(s);
      const q = projectOnSeg(x, y, r.X[s], r.Y[s], r.X[s + 1], r.Y[s + 1]);
      if (q.d <= tol && (!best || q.d < best.d)) best = { i: s, t: q.t, x: q.x, y: q.y, d: q.d };
    }
  }
  return best;
}
```

After `movePoint` add:

```js
// Add a vertex after vertex i, on the nearest street unless snap is off. The result says where it
// landed (`index`): the engine may put street nodes between i and the new point.
export function insertPoint(doc, i, lat, lon, { snap = true } = {}) {
  const { net, proj, route } = doc, n = doc.points.length;
  if (i < 0 || i >= n - 1) return null;
  let [x, y] = proj.toXY(lat, lon);
  if (snap) { const q = net.snap(x, y, 8, SNAP_RADIUS); if (q) { x = q.x; y = q.y; } }
  const [la, lo] = proj.toLL(x, y);
  const points = doc.points.slice(0, i + 1).concat([[round6(la), round6(lo)]], doc.points.slice(i + 1));
  const res = commit(doc, `add point at ${km(route.along[i])}`, points, {});
  const index = nearestVertex(doc, x, y, { after: i, tol: 1 });
  res.index = index >= 0 ? index : i + 1;
  res.range = { iA: i, iB: Math.min(doc.route.X.length - 1, res.index + 1) };
  res.legality = legality(doc.route, net, i, res.range.iB);
  return res;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/edit_test.mjs data/routes/day_01_nav.gpx 2>&1 | grep -E "FAIL|Error|passed"`
Expected: `… passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add js/edit.js tests/edit_test.mjs
git commit -m "Cleaner engine: insertPoint and nearestSegment, 60 m snap radius

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YNRNiv22cacjg4SmM6iVK3"
```

---

### Task 4: `movePoint` snaps within 60 m, reports `index`, moves one pass only (engine)

**Files:**
- Modify: `js/edit.js` (`movePoint`, ~line 298)
- Test: `tests/edit_test.mjs` section T7 (add checks) 

**Interfaces:**
- Produces: `movePoint(doc, i, lat, lon, { snap = true })` → `EditResult` with `index` (vertex index after rebuild), `range: { iA: index - 1, iB: index + 1 }`, `legality`. Snap: node within 8 m, else street within `SNAP_RADIUS` (60 m).

- [ ] **Step 1: Write the failing tests**

In section T7, right after the line `E.undo(doc);` that follows the `raw` (unsnapped move) checks and before `check(doc.points === before.points || …, 'undo restores the route');`, add:

```js
  // a 50 m move snaps onto a street within the 60 m radius and reports the vertex index
  const [wla, wlo] = doc.proj.toLL(x - 50 * by / L, y + 50 * bx / L);
  const wide = E.movePoint(doc, j, wla, wlo);
  check(!!wide && typeof wide.index === 'number' && wide.index >= 0, 'move reports the vertex index');
  check(!!net.snap(doc.route.X[wide.index], doc.route.Y[wide.index], 1.2, 4) || Math.hypot(doc.route.X[wide.index] - x, doc.route.Y[wide.index] - y) > 59, 'a 50 m move lands on a street when one is within 60 m');
  check(wide.range.iA === wide.index - 1 && wide.range.iB === wide.index + 1, 'range brackets the moved vertex');
  E.undo(doc);
  // where two passes share a spot, moving one leaves the other where it was
  let shared = -1, mate = -1;
  for (let k = 1; k < n - 1 && shared < 0; k++) { const near = E.verticesNear(doc, r.X[k], r.Y[k], 0.5).map((v) => v.i).filter((v) => v !== k); if (near.length) { shared = k; mate = near[0]; } }
  if (shared > 0) {
    const [sla, slo2] = doc.proj.toLL(r.X[shared] + 6, r.Y[shared] + 6);
    const mv2 = E.movePoint(doc, shared, sla, slo2, { snap: false });
    const mateAfter = mate > shared ? mate + (doc.route.X.length - n) : mate;
    check(!!mv2 && Math.abs(doc.route.X[mateAfter] - r.X[shared]) < 0.5 && Math.abs(doc.route.Y[mateAfter] - r.Y[shared]) < 0.5, 'the other pass through the spot stays put');
    E.undo(doc);
  } else console.log('  (no shared spot found)');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/edit_test.mjs data/routes/day_01_nav.gpx 2>&1 | grep -E "FAIL|Error|passed"`
Expected: `FAIL move reports the vertex index` and `FAIL range brackets the moved vertex`.

- [ ] **Step 3: Implement**

Replace the whole `movePoint` in `js/edit.js` with:

```js
// Move vertex i; by default it lands on the nearest street (node within 8 m, else a street within
// SNAP_RADIUS). The result says where the vertex is after the rebuild (`index`).
export function movePoint(doc, i, lat, lon, { snap = true } = {}) {
  const { net, proj, route } = doc;
  if (i < 0 || i >= doc.points.length) return null;
  let [x, y] = proj.toXY(lat, lon);
  if (snap) { const q = net.snap(x, y, 8, SNAP_RADIUS); if (q) { x = q.x; y = q.y; } }
  const [la, lo] = proj.toLL(x, y);
  const points = doc.points.slice();
  points[i] = [round6(la), round6(lo)];
  const res = commit(doc, `move point at ${km(route.along[i])}`, points, {});
  const index = nearestVertex(doc, x, y, { after: i - 1, tol: 1 });
  res.index = index >= 0 ? index : i;
  res.range = { iA: Math.max(0, res.index - 1), iB: Math.min(doc.route.X.length - 1, res.index + 1) };
  res.legality = legality(doc.route, net, res.range.iA, res.range.iB);
  return res;
}
```

- [ ] **Step 4: Run all engine tests on all files**

Run: `node tests/edit_test.mjs 2>&1 | grep -E "FAIL|Error|passed"`
Expected: `… passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add js/edit.js tests/edit_test.mjs
git commit -m "Cleaner engine: movePoint snaps within 60 m and reports the vertex index

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YNRNiv22cacjg4SmM6iVK3"
```

---

### Task 5: Cut mode trims to the hovered point (page)

**Files:**
- Modify: `cleaner/cleaner.js` (`HINT.cut` line 12; `OWN_SOURCES` line 153; `addLayers` lines 277–300; `renderMap` lines 316–335; `uturnAt` line 357; `onClick` cut branch lines 395–397; `onMove` lines 419–437; `doCut` line 470; `setMode` line 542)
- Modify: `cleaner/index.html` (Keys list)
- Verify: headless Chrome script (Step 4)

**Interfaces:**
- Consumes: `E.trimSpur(doc, u, i)`, `E.mirrorVertex(route, i, lo, hi)`, `E.cutSpur(doc, u)`, `E.verticesNear(doc, x, y, tol)`; existing page helpers `toXY`, `tol()`, `coordsOf(route, i0, i1)`, `lineFeature`, `fc`, `setData`, `afterEdit(res, message, undoable)`, `coverageText`, `sign`, `km`, `m0`.
- Produces: page state `S.trim = { u, t, m } | null`; map sources `trim` (line) and `trimdot` (point); `trimAt(x, y)`; `doTrim(u, t)`.

- [ ] **Step 1: State, hint and sources**

In `cleaner/cleaner.js`:

Replace the `cut` hint:
```js
  cut: 'Hover a spur: red is what goes, the white dot is where the car will turn back. Click to trim there; click near the base to drop the whole spur.',
```

In the `S` object add `trim: null,` after `hover: null,`.

Replace the `OWN_SOURCES` line with:
```js
const OWN_SOURCES = new Set(['sat', 'parking', 'route', 'spur', 'trim', 'trimdot', 'lost', 'preview', 'verts', 'selline', 'uturns', 'picks', 'drag']);
```

In `addLayers()` replace the source loop line with:
```js
  for (const id of ['route', 'spur', 'trim', 'trimdot', 'lost', 'preview', 'verts', 'selline', 'uturns', 'picks', 'drag']) map.addSource(id, { type: 'geojson', data: EMPTY });
```
and right after the line `line('spur', 'spur', '#fb923c', zw(5, 15), { 'line-opacity': 0.9 }, undefined);` add:
```js
  line('trim', 'trim', '#f87171', zw(5, 15), { 'line-opacity': 0.95 }, undefined);
  map.addLayer({ id: 'trimdot', type: 'circle', source: 'trimdot', paint: { 'circle-radius': 7, 'circle-color': '#ffffff', 'circle-stroke-color': '#0d0f17', 'circle-stroke-width': 2 } });
```

- [ ] **Step 2: Hover, click and the edit**

Replace `uturnAt` with:
```js
// The spur under the cursor and where on it the car would turn back
function trimAt(x, y) {
  for (const { i } of E.verticesNear(doc, x, y, tol() * 1.5)) {
    const u = doc.uturns.find((v) => v.K > 0 && v.a <= i && i <= v.b);
    if (!u) continue;
    if (i === u.i) return { u, t: u.a, m: u.b };                              // on the apex: the whole spur
    const r = doc.route;
    let t, m;
    if (i < u.i) { t = i; m = E.mirrorVertex(r, i, u.i + 1, u.b); } else { m = i; t = E.mirrorVertex(r, i, u.a, u.i - 1); }
    if (t < u.a || r.along[t] - r.along[u.a] < 10) { t = u.a; m = u.b; }      // near the base: the whole spur
    return { u, t, m };
  }
  return null;
}
const uturnAt = (x, y) => { const tr = trimAt(x, y); return tr ? tr.u : null; };
```

In `onClick`, replace the cut branch:
```js
  } else if (S.mode === 'cut') {
    const tr = trimAt(x, y);
    if (!tr) return toast('No spur under the cursor.');
    if (tr.t === tr.u.a) doCut(tr.u); else doTrim(tr.u, tr.t);
```

In `onMove`, replace the cut-mode block (from `if (S.mode !== 'cut' || moveQueued) return;` to the end of the function) with:
```js
  if (S.mode !== 'cut' || moveQueued) return;
  moveQueued = true;
  requestAnimationFrame(() => {
    moveQueued = false;
    const [x, y] = toXY(e.lngLat), tr = trimAt(x, y);
    const key = tr ? `${tr.u.k}:${tr.t}` : null, old = S.trim ? `${S.trim.u.k}:${S.trim.t}` : null;
    if (key !== old) { S.trim = tr; S.hover = tr ? tr.u.k : null; renderMap(); map.getCanvas().style.cursor = tr ? 'pointer' : ''; }
  });
}
```

After `doCut` add:
```js
function doTrim(u, t) {
  const r = doc.route, back = km(r.along[t]);
  const res = E.trimSpur(doc, u, t);
  if (!res) return toast('Cannot trim here: pick a point on the spur, not its apex.');
  const lost = res.coverage.lostMeters;
  afterEdit(res, `Trimmed spur at ${km(u.along)}: ${sign(res.deltaMeters)}, the car now turns back at ${back}. ` + (lost >= 1 ? `Loses ${m0(lost)} of ${[...new Set(res.coverage.lost.map((l) => l.name))].join(', ')}.` : 'Every street is still driven elsewhere.'), true);
}
```

In `renderMap`, after the `spur` `setData` line add:
```js
  const tr = S.mode === 'cut' ? S.trim : null;
  setData('trim', fc([tr && tr.m > tr.t ? lineFeature(coordsOf(r, tr.t, tr.m)) : null]));
  setData('trimdot', fc(tr ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon[tr.t], r.lat[tr.t]] } }] : []));
```

In `setMode` add `S.trim = null;` after `S.hover = null;`. In `afterEdit` add `S.trim = null;` after `S.preview = null;`.

In `cleaner/index.html` Keys list, change the `x` row to:
```html
        <dt>x</dt><dd>cut the whole selected spur (in Cut mode, click along a spur to trim it there)</dd>
```

- [ ] **Step 3: Syntax check**

Run: `node --check cleaner/cleaner.js && echo OK`
Expected: `OK`

- [ ] **Step 4: Headless check**

Create `/Users/mat/.claude/jobs/5e536775/tmp/trim_check.mjs` (same CDP harness as the earlier checks in that folder; copy `parking_check.mjs` and replace the body of the `try` block with):

```js
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8791/cleaner/' });
  for (let t = 0; t < 120; t++) { if (await ev(`!!(document.getElementById('stats') && !document.getElementById('stats').hidden && window.cleaner.map && window.cleaner.map.getLayer('trim'))`)) break; await sleep(500); }
  await sleep(2000);
  const before = await text('#stats');
  const pt = await ev(`(() => { const c = window.cleaner, r = c.doc.route, u = c.doc.uturns.find((u) => u.type === 'deadEnd' && !u.partial && u.i - u.a >= 3); const t = u.a + Math.floor((u.i - u.a) / 2); c.map.jumpTo({ center: [r.lon[t], r.lat[t]], zoom: 18 }); const p = c.map.project([r.lon[t], r.lat[t]]); return { x: Math.round(p.x), y: Math.round(p.y), t, k: u.k, out: r.along[u.i] - r.along[t] }; })()`);
  await key('2'); await sleep(800);
  await ev(`new Promise((r) => { const m = window.cleaner.map; if (m.loaded() && !m.isMoving()) r(1); else m.once('idle', () => r(1)); })`); await sleep(500);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x + 3, y: pt.y + 3 }); await sleep(150);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y }); await sleep(500);
  out('hover trim', JSON.stringify(await ev(`window.cleaner.S.trim && { k: window.cleaner.S.trim.u.k, t: window.cleaner.S.trim.t, m: window.cleaner.S.trim.m }`)) + ' expected k ' + pt.k + ' t ' + pt.t);
  await shot('12-trim-hover');
  await click(pt.x, pt.y); await sleep(600);
  out('before', before);
  out('after trim', await text('#stats'));
  out('toast', await text('#toastText'));
  out('expected drop', '≈ ' + Math.round(2 * pt.out) + ' m, U-turn count unchanged');
  await key('z', 'metaKey: true,'); await sleep(400);
  out('after undo', await text('#stats'));
```
(`click`, `key`, `text`, `out`, `shot` helpers are in `parking_check.mjs`/`browser_check.mjs`; `key(k, mods)` is the two-argument version from `browser_check.mjs`.)

Run: `cd <worktree> && node /Users/mat/.claude/jobs/5e536775/tmp/trim_check.mjs`
Expected: `hover trim` shows the expected `k` and `t`; `after trim` length is smaller by about `2 × out` metres and the U-turn count is unchanged; `after undo` equals `before`; `console messages: (none)`. Look at `12-trim-hover.png`: orange spur, red stretch beyond the white dot.

- [ ] **Step 5: Commit**

```bash
git add cleaner/cleaner.js cleaner/index.html
git commit -m "Cleaner: Cut mode trims a spur at the hovered point

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YNRNiv22cacjg4SmM6iVK3"
```

---

### Task 6: Points mode: insert on the line, straight delete, visible points, Points card (page)

**Files:**
- Modify: `cleaner/cleaner.js` (`HINT.points`; `addLayers` verts layers lines 297–298; `renderMap` verts line 331; `onClick` points branch lines 409–414; `onMove`; `onUp` lines 448–458; `deleteSelection` lines 499–506; `onCardClick`; `onKey` Delete case; `renderAll`; new `renderPointsCard`)
- Modify: `cleaner/index.html` (add `#pointsCard` after `#previewCard`; Keys rows)
- Modify: `cleaner/cleaner.css` (nothing new needed; `.card` styles apply)
- Modify: `README.md` ("Cleaning a route" paragraph)

**Interfaces:**
- Consumes: `E.insertPoint`, `E.nearestSegment`, `E.deletePoints(doc, i0, i1, { legal })`, `E.movePoint` (with `index`), `E.verticesNear`, `pickVertex(x, y)`, `afterEdit`, `legalityText`, `coverageText`, `flyToVertex`.
- Produces: `S.pts.hover` (vertex index under the cursor or null); map source `selline`; layer `verts-hover`; `renderPointsCard()`; card actions `delPts`, `delPtsLegal`, `flyPts`.

- [ ] **Step 1: Hint, layers, state**

In `cleaner/cleaner.js`:

Replace the `points` hint:
```js
  points: 'Click a point to select it (shift-click: a range), drag it to move it, Delete removes it and closes the gap along the street (Alt+Delete: legal detour). Click on the line between points to add one.',
```

In `S.pts` add `hover: null`: `pts: { sel: new Set(), anchor: null, drag: null, hover: null },`.

Replace the two `verts` layers in `addLayers()` with:
```js
  map.addLayer({ id: 'selline', type: 'line', source: 'selline', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#8b7cf6', 'line-width': zw(7, 18), 'line-opacity': 0.7 } });
  map.addLayer({ id: 'verts', type: 'circle', source: 'verts', minzoom: 14, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 2.5, 18, 6], 'circle-color': ['case', ['>=', ['get', 'node'], 0], '#f2f3f7', '#9ba1b2'], 'circle-stroke-color': '#0d0f17', 'circle-stroke-width': 1 } });
  map.addLayer({ id: 'verts-hover', type: 'circle', source: 'verts', filter: ['==', ['get', 'i'], -1], paint: { 'circle-radius': 10, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'verts-sel', type: 'circle', source: 'verts', filter: ['==', ['get', 'sel'], 1], paint: { 'circle-radius': 7, 'circle-color': '#8b7cf6', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
```

In `renderMap`, after the `verts` `setData` line add:
```js
  const sel = [...S.pts.sel].sort((p, q) => p - q);
  setData('selline', fc([S.mode === 'points' && sel.length > 1 ? lineFeature(coordsOf(r, sel[0], sel[sel.length - 1])) : null]));
```

- [ ] **Step 2: Hover ring and insert on the line**

In `onMove`, right after the parking-hover block (before `if (!doc) return;`) nothing changes; after the `if (S.pts.drag) { … return; }` block add:
```js
  if (S.mode === 'points') {
    const [x, y] = toXY(e.lngLat), i = E.nearestVertex(doc, x, y, { tol: tol() });
    if (i !== S.pts.hover) { S.pts.hover = i < 0 ? null : i; map.setFilter('verts-hover', ['==', ['get', 'i'], i]); map.getCanvas().style.cursor = i >= 0 ? 'grab' : (E.nearestSegment(doc, x, y, tol()) ? 'copy' : ''); }
    return;
  }
```

Replace the points branch of `onClick` with:
```js
  } else if (S.mode === 'points') {
    const i = pickVertex(x, y);
    if (i >= 0) {
      if (e.originalEvent.shiftKey && S.pts.anchor != null) { S.pts.sel.clear(); for (let k = Math.min(S.pts.anchor, i); k <= Math.max(S.pts.anchor, i); k++) S.pts.sel.add(k); }
      else { S.pts.sel.clear(); S.pts.sel.add(i); S.pts.anchor = i; }
      renderAll();
      return;
    }
    const seg = E.nearestSegment(doc, x, y, tol());
    if (!seg) { S.pts.sel.clear(); S.pts.anchor = null; renderAll(); return; }
    const res = E.insertPoint(doc, seg.i, e.lngLat.lat, e.lngLat.lng, { snap: !e.originalEvent.altKey });
    if (!res) return toast('Cannot add a point here.');
    S.pts.sel.clear(); S.pts.sel.add(res.index); S.pts.anchor = res.index;
    afterEdit(res, 'Point added. Drag it to pull the route through another street. ' + legalityText(res.legality), true);
  }
```

- [ ] **Step 3: Move and delete**

Replace `onUp` with:
```js
function onUp(e) {
  const d = S.pts.drag;
  if (!d) return;
  S.pts.drag = null;
  map.dragPan.enable();
  map.getContainer().classList.remove('dragging');
  const res = E.movePoint(doc, d.i, e.lngLat.lat, e.lngLat.lng, { snap: !(d.alt || e.originalEvent.altKey) });
  if (!res) return renderMap();
  S.pts.sel.clear(); S.pts.sel.add(res.index); S.pts.anchor = res.index;
  const off = res.legality.offStreet;
  afterEdit(res, off > 1
    ? `Point moved, but ${m0(off)} of the route is off the street map: no street path within reach. Add points along the way, or move it closer to a street.`
    : 'Point moved. ' + legalityText(res.legality), true);
}
```

Replace `deleteSelection` with:
```js
function deleteSelection(legal) {
  if (!S.pts.sel.size) return toast('Select a point first (click it; shift-click for a range).');
  const idx = [...S.pts.sel].sort((p, q) => p - q);
  const res = E.deletePoints(doc, idx[0], idx[idx.length - 1], { legal });
  if (!res) return toast('Those points cannot be deleted (the route must keep its start and end).');
  S.pts.sel.clear(); S.pts.anchor = null;
  afterEdit(res, `Deleted ${idx.length} point(s): ${sign(res.deltaMeters)}${legal ? ' (legal detour)' : ''}. ` + coverageText(res.coverage) + ' ' + legalityText(res.legality), true);
}
```

In `onKey`, replace the Delete case with:
```js
    case 'Delete': case 'Backspace': if (S.mode === 'points') { e.preventDefault(); deleteSelection(e.altKey); } break;
```
(unchanged text, but now `altKey` means *legal detour* because `deleteSelection` takes `legal`).

In `onCardClick` add cases:
```js
    case 'delPts': deleteSelection(false); break;
    case 'delPtsLegal': deleteSelection(true); break;
    case 'flyPts': { const s = [...S.pts.sel]; if (s.length) flyToVertex(Math.min(...s)); break; }
```

- [ ] **Step 4: Points card**

In `cleaner/index.html` after `<section id="previewCard" class="card" hidden></section>` add:
```html
    <section id="pointsCard" class="card" hidden></section>
```
and in the Keys list replace the Alt row with:
```html
        <dt>click on the line</dt><dd>add a point there (Alt: without snapping)</dd>
        <dt>Delete / Alt+Delete</dt><dd>remove the selected points: gap closed along the street / legal detour</dd>
        <dt>Alt + drag</dt><dd>move a point without snapping to a street</dd>
```

In `cleaner/cleaner.js` add after `renderPreview`:
```js
function renderPointsCard() {
  const card = $('pointsCard');
  card.hidden = S.mode !== 'points';
  if (card.hidden) return;
  const sel = [...S.pts.sel].sort((p, q) => p - q), r = doc.route, net = doc.net;
  if (!sel.length) {
    card.innerHTML = '<h2>Points</h2><div class="meta">No point selected. Click a point, or click on the line to add one.</div>';
    return;
  }
  const a = sel[0], b = sel[sel.length - 1], h = r.half[Math.min(a, r.half.length - 1)];
  const street = h >= 0 ? net.nameOf(net.way(h)) || '(no name)' : '(not on a street)';
  const passes = E.verticesNear(doc, r.X[a], r.Y[a], 0.5).length;
  card.innerHTML = `
    <h2>${sel.length === 1 ? 'Point' : sel.length + ' points'} · ${km(r.along[a])}${sel.length > 1 ? ' → ' + km(r.along[b]) : ''}</h2>
    <div class="meta"><b>${escapeHtml(street)}</b>${passes > 1 ? ` · ${passes} passes meet here (click again for the next)` : ''}<br>
      ${sel.length > 1 ? `${m0(r.along[b] - r.along[a])} of route selected.` : 'Drag to move it.'}</div>
    <div class="actions">
      <button class="btn small primary" data-act="delPts">Delete <kbd>⌫</kbd></button>
      <button class="btn small" data-act="delPtsLegal">Delete, legal detour</button>
      <button class="btn small quiet" data-act="flyPts">Fly to</button>
    </div>`;
}
```
In `bindPanel` add `$('pointsCard').addEventListener('click', onCardClick);`. In `renderAll` add `renderPointsCard();` after `renderPreview();`. In `setMode` add `S.pts.hover = null; if (mapReady) map.setFilter('verts-hover', ['==', ['get', 'i'], -1]);` after `S.pts.anchor = null;`.

- [ ] **Step 5: README**

In `README.md`, in the "Cleaning a route" section replace the sentence starting `**Points** (drag a vertex, it snaps to the street; select a range and press` … `Delete).` with:
```
**Points** (click a point to select it, drag it to move it onto a street, click on the line to add a point;
Delete removes the selection and closes the gap along the street, Alt+Delete fills it with a legal detour).
In Cut mode the click lands where the car will turn back, so a spur can be shortened instead of dropped.
```

- [ ] **Step 6: Syntax check and headless check**

Run: `node --check cleaner/cleaner.js && echo OK` → `OK`.

Create `/Users/mat/.claude/jobs/5e536775/tmp/points_check.mjs` from the same harness; `try` body:
```js
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8791/cleaner/' });
  for (let t = 0; t < 120; t++) { if (await ev(`!!(document.getElementById('stats') && !document.getElementById('stats').hidden && window.cleaner.map && window.cleaner.map.getLayer('selline'))`)) break; await sleep(500); }
  await sleep(2000);
  await key('4'); await sleep(300);
  out('card empty', await text('#pointsCard'));
  // a 40 m street piece: click its middle to add a point
  const seg = await ev(`(() => { const c = window.cleaner, r = c.doc.route, n = r.X.length; let s = -1; for (let k = 1; k < n - 2; k++) if (r.half[k] >= 0 && r.along[k + 1] - r.along[k] > 40 && r.node[k] >= 0 && r.node[k + 1] >= 0) { s = k; break; } const lon = (r.lon[s] + r.lon[s + 1]) / 2, lat = (r.lat[s] + r.lat[s + 1]) / 2; c.map.jumpTo({ center: [lon, lat], zoom: 18 }); const p = c.map.project([lon, lat]); return { x: Math.round(p.x), y: Math.round(p.y), s, n }; })()`);
  await ev(`new Promise((r) => { const m = window.cleaner.map; if (m.loaded() && !m.isMoving()) r(1); else m.once('idle', () => r(1)); })`); await sleep(500);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: seg.x + 2, y: seg.y + 2 }); await sleep(200);
  out('cursor', await ev(`window.cleaner.map.getCanvas().style.cursor`) + ' (expected copy)');
  await click(seg.x, seg.y); await sleep(500);
  out('after insert', `vertices ${await ev('window.cleaner.doc.points.length')} (expected ${seg.n + 1}) | sel ${await ev('[...window.cleaner.S.pts.sel].join()')} | ${await text('#toastText')}`);
  out('card', await text('#pointsCard'));
  // drag it 30 m sideways, then delete it
  const drag = await ev(`(() => { const c = window.cleaner, r = c.doc.route, i = [...c.S.pts.sel][0]; const p = c.map.project([r.lon[i], r.lat[i]]); return { x: Math.round(p.x), y: Math.round(p.y) }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: drag.x, y: drag.y, button: 'left', clickCount: 1 }); await sleep(100);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.x + 30, y: drag.y + 30, button: 'left' }); await sleep(100);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.x + 60, y: drag.y + 60, button: 'left' }); await sleep(100);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drag.x + 60, y: drag.y + 60, button: 'left', clickCount: 1 }); await sleep(600);
  out('after drag', await text('#toastText'));
  await shot('13-points-moved');
  await key('Delete'); await sleep(500);
  out('after delete', `vertices ${await ev('window.cleaner.doc.points.length')} | ${await text('#toastText')}`);
  await key('z', 'metaKey: true,'); await sleep(300); await key('z', 'metaKey: true,'); await sleep(300); await key('z', 'metaKey: true,'); await sleep(300);
  out('after 3 undo', `vertices ${await ev('window.cleaner.doc.points.length')} (expected ${seg.n}) dirty ${await ev('window.cleaner.doc.dirty')}`);
```
Run it from the worktree root with the server up. Expected: cursor `copy` beside the line; after insert vertex count n+1 and a "Point added" toast with the Points card showing the street; after drag a "Point moved" toast (no off-street warning when a street is within 60 m); after delete the toast says the gap was closed and no detour; after three undos the count is back to n and `dirty false`; no console messages. Open `13-points-moved.png`: the moved vertex is on a street with the route threaded through it.

- [ ] **Step 7: Full test run and commit**

Run: `node tests/edit_test.mjs 2>&1 | grep -E "FAIL|passed" && node tests/server_test.mjs 2>&1 | grep -E "FAIL|passed"`
Expected: both `0 failed`.

```bash
git add cleaner/cleaner.js cleaner/index.html README.md
git commit -m "Cleaner: add points on the line, straight delete by default, hover ring, Points card

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YNRNiv22cacjg4SmM6iVK3"
git push origin worktree-gpx-cleaner
```

---

## Self-review notes

- Spec coverage: trim-to-point → Tasks 1, 5; straight delete → Tasks 2, 6; insert and drag → Tasks 3, 4, 6; easier to find points → Task 6 (zoom 14, ring, range line, card). README updated in Task 6.
- Names used across tasks: `trimSpur`, `mirrorVertex`, `nearestSegment`, `insertPoint`, `SNAP_RADIUS`, `movePoint(...).index`, `deletePoints(..., { legal })`, `S.trim`, `S.pts.hover`, sources `trim`, `trimdot`, `selline`, layer `verts-hover`, card `#pointsCard`, actions `delPts`/`delPtsLegal`/`flyPts` — consistent.
- Review Focus 1–5 are pinned in Tasks 1, 1, 2, 3, 4 respectively.
