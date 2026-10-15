# Route cleaner: point-level editing (design)

Date: 2026-10-15. Branch `worktree-gpx-cleaner`. Follows the 2026-10-14 cleaner design.

## Problem

Mat tried to clean a day with the cleaner and found the tools too coarse:

- **Cut spur** is all or nothing: it removes the whole out-and-back. Often only the last stretch of a
  dead-end street is pointless (a yard, a gate) and the car should still drive the first part and turn
  back earlier.
- **Points mode** (key 4) did not do what he expected: deleting points inside a spur refilled the gap
  with a legal detour around the block instead of simply closing the gap; dragging a vertex did not
  visibly redirect the route; vertices were hard to find and to pick (visible only from zoom 15, two
  vertices on the same spot where the route passes twice).

His words: "select a point and then either delete it, or move it … without deleting the whole spur";
on refilling a deleted stretch: "there will be nothing to be filled".

## What changes

1. **Trim a spur to a point.** In Cut mode the cursor on a spur marks where the car will turn back:
   the stretch beyond that point (out and back) is drawn red and one click removes exactly that. Near
   the base of the spur the whole spur goes, as before. Works from either leg of the spur.
2. **Delete closes the gap along the street.** Deleting selected points joins the neighbours by the
   shortest street path (which, for points on one street, is just that street; for the end of a spur,
   a turn-back at the new last point). No detour is ever inserted unless asked for with Alt.
   The tool still warns if the join drives a one-way the wrong way or is off the street map.
3. **Insert a point.** Clicking on the route line between points adds a vertex there (snapped to the
   street) and selects it; dragging it pulls the route through another street. Snapping radius for
   moved and inserted points grows to 60 m; if the engine cannot find a street path to the new spot
   within its reach the toast says so and suggests adding points along the way.
4. **Points are easier to find.** Vertices show from zoom 14 and are larger; the vertex under the
   cursor gets a ring; the selected range is drawn as a line; a Points card in the panel shows what is
   selected (count, km, street, pass) with Delete / Delete with legal detour / Fly to buttons.

## Engine additions (`js/edit.js`, all tested in Node)

- `trimSpur(doc, u, i)` — turn back at vertex `i` of U-turn `u` instead of at its apex.
- `mirrorVertex(route, i, lo, hi)` — the vertex in `lo..hi` nearest to vertex `i` (the same spot on the other leg).
- `insertPoint(doc, i, lat, lon, {snap})` — new vertex after `i`; result carries `index` of the vertex after rebuild.
- `nearestSegment(doc, x, y, tol)` — the route piece under the cursor.
- `deletePoints` default becomes the plain street fill (`legal: false`); `movePoint` snaps within 60 m and reports `index`.

## Out of scope

Reroute mode, parking overlay and satellite view are unchanged. Nothing is computed against the
parking data.
