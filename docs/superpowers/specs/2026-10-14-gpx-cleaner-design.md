# GPX Route Cleaner: U-turn review and editing tool

Worktree: `/Users/mat/GitHub/STS-Labs/survey-navigator-preview/.claude/worktrees/gpx-cleaner` (branch `worktree-gpx-cleaner`, base `1b1a3b1`). All paths below are relative to it.

## Context

The six survey days in `data/routes/*.gpx` (138–177 km each, ~930 km total) come from an external OsmAnd-based planner. Drivers get sent into streets only to U-turn and come back. The existing engine (`js/core.js`) already snaps each track to the Tbilisi OSM street network and detects maneuvers, including U-turns with a dead-end flag; `tests/plan_check.mjs` counts 30–52 U-turns per day, ~40 % of them *not* at dead ends (the likely inefficiencies).

Goal: a simple local web tool inside this repo to **load any route, see every U-turn on the map, edit the route to remove needless ones, and save a cleaned GPX** that STS NAV can drive. This is the first filter; the next feature (not built now) splits a route into ~100 km survey days from the shared depot (all days start/end near 41.7057, 44.7737), so the model keeps a home point and cumulative km, and the writer takes an explicit point list.

Decisions agreed with the user:
- Edit **inside the tool**: cut spur, reroute between two points, drag/delete points; undo/redo.
- Show **all U-turns grouped by type** (dead end / spur / mid-street) with filters.
- Coverage rule **warn only**: an edit dropping a street not driven elsewhere warns; the user decides.
- Output keeps **`<rte>` + `<trk>` in sync**; consumer is **STS NAV only** (no OsmAnd `<route>` segment block).
- Save as **separate `data/routes/<name>_clean.gpx`**; originals never modified.
- Later split counts **survey km only**.

Measured facts: `prepare()` = 65 ms for the longest day; **rebuilding a route from its own snapped vertices (6-decimal lat/lon) is an exact fixed point** on day_01/03/05/zuka (same vertex count, length, `half[]`, U-turn count on pass 1). So the document can be the snapped vertex list, rebuilt after every edit.

## Approach

Static page in this repo reusing the engine, bundled MapLibre and the night theme; a zero-dependency Node server serves the repo and writes `_clean.gpx`. No build step. New logic lives in a DOM-free module tested in Node against the real files (TDD, same plain-script style as `tests/drive_test.mjs`).

## Files

| File | Role |
| --- | --- |
| `js/edit.js` (new) | Pure module: document, U-turn analysis, edit ops, undo, GPX writer. Runs in Node. |
| `tests/edit_test.mjs` (new) | Node tests T1–T8 on real files. |
| `tools/cleaner_server.mjs` (new) | Static server on 127.0.0.1:8791 + `/api/routes` list/get/put. |
| `cleaner/index.html`, `cleaner/cleaner.js`, `cleaner/cleaner.css` (new) | The page. |
| `docs/superpowers/specs/2026-10-14-gpx-cleaner-design.md` (new) | This design, committed first. |
| `README.md` | "Cleaning a route" section. |

Untouched and reused: `js/core.js` (`prepare`, `buildRoute` L383, `detectManeuvers` L504, `apexes` L495, `findWayBack` L651, `Network.snap` L246, `parseGpx`, `pointAt`), `vendor/maplibre-gl-4.7.1`, `css/app.css` tokens, `NIGHT` + `nightTheme()` + `addRouteLayers()` patterns in `js/app.js:247-389`, `findWayBack` parameters from `tools/make_route.mjs:48-61`. `js/days.js`, `sw.js`, driver app: unchanged.

## 1. `js/edit.js`

**Document** (`net`/`proj` from `prepare()` once per file, never rebuilt, so half-edge/node ids stay comparable across edits):
```js
doc = { file, name, net, proj, points /*[[lat,lon]] 6-dec*/, route /*buildRoute + .maneuvers*/,
        cov /*Uint16Array(net.segCount) passes per undirected segment*/, uturns, grid /*25 m cells → vertex idx*/,
        history: [], future: [], dirty, savedPoints, home /*[lat,lon] of vertex 0*/, original: {points,total,uturnCount} }
```

**API**
```js
openDoc(gpxText, netDoc, {file})      // prepare → points = round6(route.lat/lon) → rebuild; assert fixed point (n, half identical) else adopt once
rebuild(doc)                          // buildRoute({name, points}) + detectManeuvers; cov, uturns, grid
halfRuns(route) → [{h,i0,i1}]         // maximal runs of equal half (handles a mid-segment vertex on one leg)
coverageTable(route, {directed=false})
analyzeUturns(doc) → Uturn[]          // Uturn = {k,i,along,type,a,b,K,partial,spurMeters,loopMeters,name,verdict,mergedTo?,lat,lon}
spurExtent(route, i) → {a,b,K,partial}
verdictForRange(doc, a, b) → {ok, lostMeters, lost:[{s,name,meters}]}
coverageDiff(oldRoute, newRoute, net) → {lost, gained, lostMeters, gainedMeters}
legality(route, net, i0, i1) → {wrongWay, banned, offStreet}   // plan_check.mjs:8-17 logic
cutSpur(doc, u) → EditResult|null
previewReroute(doc, iA, iB, opts) → RerouteResult|null          // pure
reroute(doc, iA, iB, opts) → EditResult|null
movePoint(doc, i, lat, lon, {snap=true}) → EditResult
deletePoints(doc, i0, i1, {legal=true}) → EditResult|null
undo(doc)/redo(doc) → boolean;  commit(doc, label, newPoints) → EditResult
verticesNear(doc, x, y, tol=15); nearestVertex(doc, x, y, {after=-1, nodeOnly=false, tol=15})
legalPath(doc, iFrom, iTo)            // start/goal construction helper shared by reroute, deletePoints and the future splitter
writeGpx(doc, {name, route, points}) → string;  cleanName(file)
// EditResult = {label, deltaMeters, uturnsBefore, uturnsAfter, coverage, legality?, seam?, range}
```

**U-turn analysis.** For each maneuver `kind==='uturn'`:
- `mergedTo != null` (divided-road merge, core.js:616-626): `type='midStreet'`, `a=i`, `b=mergedTo`, `K=0`.
- Retrace iff `half[i-1]>=0 && half[i]===(half[i-1]^1)`. Retrace at node with `deg===1` → `deadEnd`; at node `deg>=2` → `spur`; otherwise (bearing flip ≥165°, off-network, or mid-block apex) → `midStreet`.
- `spurExtent`: over `halfRuns`, with `r` the run ending at `i`, walk `K` while `runs[r-K].h>=0 && runs[r+1+K].h === runs[r-K].h^1`; `a = runs[r-K+1].i0`, `b = runs[r+K].i1`; `partial = dist(a,b) > 0.5 m`.
- `spurMeters = along[i]-along[a]`, `loopMeters = along[b]-along[a]`; `verdict = verdictForRange(a,b)`: a segment is lost if `cov[s] - passesInside[s] === 0`.

**Edits** (each ends in `commit` → `rebuild`; results carry coverage/legality for the UI to warn):
- `cutSpur`: requires `K>0`; `newPoints = points.slice(0,a+1).concat(points.slice(b))` (buildRoute dedupes coincident a/b, `connect` fills a partial gap). Seam warning if `net.banned(half[a-1], half[b])`.
- `previewReroute`: snap `iA` back / `iB` forward to node vertices. `starts = [{h: half[iA-1], remain: 0, x: X[iA], y: Y[iA]}]` (or all allowed `adj(node[iA])` with `remain = sLen` when `iA===0`); `goals = Map([[half[iB], {extra:0}]])` (or `half[iB-1]` when `iB===n-1`). `findWayBack(net, proj, null, null, goals, 80000, starts, {street:5000, deadEnd:3000}, {service:8, minor:12})`. Splice `points[0..iA] ++ path.lat/lon ++ points[iB+1..]` without hand-trimming (buildRoute dedupes the duplicate seam vertices). Scratch-build to compute `deltaMeters`, `coverageDiff`, new `iB`, `uturnsInside`, `legality`. Null → `{reason:'no-route'}`.
- `movePoint`: `net.snap(x,y,8,30)` when snapping; report `legality(i-1,i+1)`.
- `deletePoints`: `legal` → `reroute(i0-1, i1+1)`; else plain splice (connect fill ignores one-way; report legality). Keep vertex 0 and n-1.

**Writer** `writeGpx`: header as originals (`creator="STS NAV cleaner"`, `xmlns:osmand`); `<rte><name>` + one `rtept` per `unique(sorted([0, ...maneuvers.i (not arrive), n-1]))` with `Planned point k` and `<osmand:profile>car</osmand:profile><osmand:trkpt_idx>idx</osmand:trkpt_idx>`, coords taken from `points[idx]` so rtept === trkpt byte-for-byte; `<trk><name>… (navigation)</name><trkseg>` of `<trkpt lat lon/>` (6 decimals); no `<extensions><route>`. `esc` for `& < >`.

## 2. `tools/cleaner_server.mjs`

`node tools/cleaner_server.mjs [port=8791]`, binds 127.0.0.1, prints the cleaner URL. Static from repo root with path-escape check, `Cache-Control: no-store`, MIME map (html, js/mjs, css, json, gpx, png, svg, woff2, webmanifest, m4a).
- `GET /api/routes` → `[{file, bytes, mtime, clean, hasClean}]` from `data/routes/*.gpx`.
- `GET /api/routes/:file` — name must match `/^[A-Za-z0-9][A-Za-z0-9._-]*\.gpx$/`, `basename===file`.
- `PUT /api/routes/:file` — same, plus `/_clean\.gpx$/` required (403 otherwise); 32 MB limit; body must contain `<gpx` and `<trkpt`; write `.tmp` then `rename`; `{ok, bytes, path}`.
- Use `127.0.0.1:8791` so the driver app's service worker (registered only on `localhost`, app.js:1189) never intercepts; `cleaner.js` also unregisters any SW defensively.

## 3. `cleaner/` page

`index.html` links `../vendor/maplibre-gl-4.7.1/*`, `../css/app.css` (tokens, `.glass`, `#map`), `cleaner.css`; module `cleaner.js`. Full-screen map; left 360 px glass panel: **File** (select + Load, target name, dirty badge), **Stats** (km, U-turns by type, Δ vs original), **Modes** (Select · Cut · Reroute · Points), **Selection** card (type, km, street, spur m, verdict + lost streets, Cut / Reroute around / Fly to), **Preview** card (Δ m, lost/gained, U-turns removed, legality; Apply/Cancel), **U-turn list** with type filters, **History** (Undo/Redo), **Save** (PUT) + **Download**, **Help**.

Map: `STYLE` liberty + copied `NIGHT`/`nightTheme()`/`calmMap()`; GeoJSON sources inserted before the first label layer: `route` (line + chevrons), `spur` (orange, selected/hovered extent), `uturns` (circles by type: deadEnd grey, spur amber, midStreet red; selected ring), `lost` (red dashed), `preview` (green dashed), `verts` (minzoom 15, Points mode only), `picks` (A/B).

State machine: `mode ∈ {select, cut, reroute, points}`; select: click marker/row → select + flyTo, `n`/`p` cycle, `x` cut, `r` reroute around (A ≥60 m before `a`, B ≥60 m after `b`); cut: hover highlights the spur containing the nearest vertex, click cuts, toast with verdict + Undo; reroute: click A (nearest node vertex), click B (candidates with `i > A`, `←/→` cycles passes of the same street), preview, Enter applies; points: drag (snap unless Alt), click/shift-click range, Delete (legal fill unless Alt). Global: Cmd/Ctrl+Z/Shift+Z, Cmd/Ctrl+S, `1-4`, `f` fit, `u` toggle markers, Esc. After every edit: one `render()` (setData on route/uturns/verts, re-resolve selection by position within 30 m, stats/list/history, dirty title + `beforeunload`). Save: PUT `cleanName(doc.file)`; on error fall back to Blob download.

## 4. Tests `tests/edit_test.mjs`

`node tests/edit_test.mjs [day.gpx] [net.json]`; default runs cheap tests on all 7 files and heavy ones on day_01. `check(ok,msg)` + exit code.
- **T1 fixed point** (all): `openDoc` → rebuild again → same `n`, identical `half`, `|Δtotal|<0.01`; vs `prepare(original)`: same U-turn count.
- **T2 analysis** (day_01): `uturns.length === 48` and `=== maneuvers uturn count`; deadEnd count equals `m.deadEnd` count (31); retrace types have `K>=1`, `a<i<b`, `!partial ⇒ dist(a,b)<0.5`; merged ones present with `K=0`.
- **T3 coverage**: `sum(cov) === count(half>=0)`.
- **T4 cutSpur** on first deadEnd: U-turns −1; `|deltaMeters + (along[b]-along[a]-dist(a,b))| < 1`; prefix unchanged; `dirty`; undo restores points exactly; redo re-applies.
- **T5 GPX round-trip** (all): `parseGpx(writeGpx(doc))` same points within 1e-6; no `<segment`/`<route>`; `trkpt_idx` strictly increasing, first 0, last n-1, rtept text equals trkpt text; `prepare(text)` → same n and U-turn count.
- **T6 reroute** on first non-deadEnd U-turn: non-null; `uturnsInside` empty; no wrongWay/banned/offStreet; prefix/suffix unchanged; U-turns ≤ before −1; `{maxCost:10}` → null.
- **T7 movePoint/deletePoints**: delete 3 mid-block vertices (`legal:false`) → `|Δ|<1 m`, all fill halves ≥0; move a node vertex 3 m sideways with snap → returns within 0.5 m; without snap → `offStreet>0`.
- **T8 cleanName**: `day_01_nav.gpx → day_01_nav_clean.gpx`, idempotent, `zuka-testdrive.gpx → zuka-testdrive_clean.gpx`.

## 5. Order of work

0. Write the spec file under `docs/superpowers/specs/` and commit.
1. T1 + T8 → `openDoc/rebuild/cleanName`.
2. T2/T3 → `halfRuns`, `coverageTable`, `spurExtent`, `verdictForRange`, `analyzeUturns`.
3. T4 → `commit`, `cutSpur`, `undo/redo`, `coverageDiff`.
4. T5 → `writeGpx`.
5. T6 → `legalPath`, `previewReroute/reroute`, `legality`, `verticesNear/nearestVertex`.
6. T7 → `movePoint`, `deletePoints`.
7. `tools/cleaner_server.mjs` + curl checks.
8. `cleaner/` page; browser check via Chrome DevTools MCP (load day_01, select a U-turn, cut, reroute, undo, save, confirm file appears).
9. README section; commit on `worktree-gpx-cleaner`, push, open draft PR.

## Verification

```
node tests/edit_test.mjs
node tests/edit_test.mjs data/routes/day_03_nav.gpx data/tbilisi-net.json
node tools/cleaner_server.mjs            # then in another shell:
curl -s http://127.0.0.1:8791/api/routes | head -c 300
curl -s -o /dev/null -w '%{http_code}\n' -X PUT --data '<gpx><trkpt/></gpx>' http://127.0.0.1:8791/api/routes/day_01_nav.gpx   # 403
curl -s -o /dev/null -w '%{http_code}\n' -X PUT --data '<gpx><trkpt/></gpx>' http://127.0.0.1:8791/api/routes/tmp_clean.gpx   # 200; rm it after
# after saving a real clean file from the UI:
node tests/plan_check.mjs data/routes/day_01_nav_clean.gpx data/tbilisi-net.json    # fewer U-turns, no new wrong-way/banned
node tests/drive_test.mjs data/routes/day_01_nav_clean.gpx data/tbilisi-net.json    # still PASS
```
Existing tests (`plan_check`, `route_check`, `drive_test`) on the original files must be unchanged.

## Known limits (documented in README)
- Coverage granularity is the undirected network segment; `coverageTable({directed:true})` exists for a both-kerbs survey.
- Reroutes can only use streets inside the route bbox + ~2.7 km (network clip in `prepare`).
- Plain point edits fill with the shortest path ignoring one-way rules; the tool shows a legality warning (the legal fill is the default for deletes).
- `js/days.js`/`sw.js` keep serving the originals until a day is pointed at its `_clean` file.
