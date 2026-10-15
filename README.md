# STS NAV (Survey Navigator)

Turn-by-turn navigation on an iPhone for street-coverage routes: the kind of GPX a survey car follows
when it has to drive every street of an area, passing the same junctions several times.

Ordinary apps (OsmAnd, Google Maps) draw the whole day's line at once, so at a junction the driver sees
three or four branches and cannot tell which one is now. This app shows only the road ahead, says each
turn, never jumps to another pass of the same street, brings the driver back to the exact spot when a
turn is missed, and keeps a record of what was really driven.

## For the driver

1. Open the app's web address in Safari, then Share → Add to Home Screen.
2. Open the app: the days are shown straight away as tiles with their length (and how far this phone got).
   Tap the day (**დღე 1** to **დღე 6**); its GPX loads.
   Another route can still be opened from a file (**მარშრუტის ფაილის გახსნა (GPX)**).
3. Mount the phone, connect the charger, tap **ნავიგაციის დაწყება** (start navigation).
   iPhone setting: Display & Brightness → Auto-Lock → Never.

The screens are in Georgian only. The spoken instructions are recorded in Georgian (40 short clips in
`audio/ka/`, joined like "200 მეტრში" + "მოუხვიეთ მარჯვნივ"; the list is in `js/voice.js`). If a clip is
missing, the iPhone's English voice says that line instead. On iPhones with iOS 16.4 or newer the voice
also plays with the ring / silent switch on silent.

The six supplied daily routes are bundled unchanged in `data/routes/`. They are cached with the app
after a successful online service-worker installation, so the day picker also works offline once
that download is complete. Each GPX keeps its own saved progress; choosing another day does not clear it.

The look is the night design approved in Figma on 14 Oct 2026 (file "Survey Navigator", page
"Design (night)"): navy map, glass cards, violet accent, fonts Inter (numbers, Latin) and Noto Sans
Georgian, both kept in `fonts/` so they work offline.

The driving screen: the instruction card top left (arrow, distance, what to do, street), menu, sound and
pause top right (while paused the pause button turns violet with a play sign: tap it to continue), and at the bottom a slim line with the time left (green), km left and the time the day ends
(violet), a GPS dot (green good, amber rough, red poor, grey none) and the progress line (red marks =
missed stretches). Under the card: **შემდეგ** (the turn right after this one) and **გამოტოვება**, which
skips the next turn (closed street): the stretch goes on the missed list and the message offers the way back.
The card is orange with a tag after leaving the route, blue on the way to the start or back to where the
drive stopped, grey while waiting for GPS or paused.

On the map: **blue to violet** = the next 320 m, dimmer violet = the road after that, white arrow = the next
turn, **orange** = the way back after a missed turn (**blue** on the way to the start or to where the drive
stopped), **red dashes** = stretches missed so far. The map can be moved and zoomed with the fingers at any
time; the violet re-centre button (bottom right, shown only while the map is moved away) brings it back to
the car, and it also comes back by itself after 20 seconds.

Menu: pause navigation (a break: GPS off, nothing recorded; continue when ready), continue from where I am,
go back one turn, the missed list, send missed stretches / the driven track as GPX, the whole day on the map,
practice drive (simulation), stop. The menu closes with a tap above it, its Close button, or by pulling
it down (a short pull springs back).

## How it works

| Step | What happens | Where |
| --- | --- | --- |
| Read the GPX | track points (or route points) in file order | `js/core.js` `parseGpx` |
| Match to streets | every point is placed on the OpenStreetMap street network; gaps between points are filled along the streets | `buildRoute` |
| Turn list | at each junction: turn if the route turns and another street leaves there; *keep left/right* at forks; roundabouts get one instruction with the exit number; U-turns at the turn-back point | `detectManeuvers` |
| Where am I | each GPS fix is matched only to the part of the route the car could have reached since the last fix, so a later pass of the same street never wins | `Navigator.update` |
| Missed a turn | legal way back (one-way streets, OSM turn bans, U-turns discouraged) to the junction where the car left | `findWayBack` |
| Coverage | the route is kept in 10 m pieces, ticked off from the car's own GPS track; anything behind the car not ticked is on the missed list | `Navigator.coverage` |

Street data: `data/tbilisi-net.json`, all drivable OpenStreetMap streets of Tbilisi with names, one-way
flags and turn restrictions (3.9 MB, 1.3 MB compressed). Map tiles: OpenFreeMap. Both are kept on the
phone by `sw.js`, so a dead spot does not stop navigation. Outside Tbilisi the app still works, with
arrows from the line's shape only.

## Rebuilding the street data

```bash
uv run --with osmium python -I tools/build_network.py <georgia-latest.osm.pbf> data/tbilisi-net.json
```

Get the extract from https://download.geofabrik.de/europe/georgia-latest.osm.pbf.

## Making a test route

```bash
node tools/make_route.mjs places.json test.gpx
```

`places.json` lists the stops in order: `{"name": "...", "points": [{"name": "...", "lat": 41.72, "lon": 44.71, "street": "optional OSM street name"}]}`.
Each stop is placed on the nearest drivable street (or on the named one), and the legs between stops follow
legal turns on real streets: no U-turns in the street, service roads and yards only where a stop is.

## Checks

```bash
node tests/route_check.mjs day.gpx data/tbilisi-net.json      # matching and turn-list numbers
node tests/plan_check.mjs day.gpx data/tbilisi-net.json       # wrong-way, banned turns, private streets, U-turns
node tests/drive_test.mjs day.gpx data/tbilisi-net.json       # whole-day simulated drives, pass/fail
node tests/junction_sheet.mjs day.gpx data/tbilisi-net.json out.html all   # one drawing per instruction
```

`drive_test` drives the whole day in simulation: clean GPS, 9 m GPS noise, a missed turn every 20
instructions, two-minute GPS gaps, and a driver who ignores the way back. The test that matters most is the
coverage audit: every metre of the route must be either really driven or on the missed list.

## Cleaning a route

The planner's routes send the car into streets only to turn round and come back. The route cleaner shows
every U-turn of a day on the map and lets you edit the route until it is smoother:

```bash
node tools/cleaner_server.mjs            # then open http://127.0.0.1:8791/cleaner/
node tests/edit_test.mjs                 # the cleaner's engine, checked on every file in data/routes
node tests/server_test.mjs               # the cleaner's server
```

Pick a day; its U-turns are listed by km and marked on the map: **dead end** (grey: the car had to turn
round at the end of a cul-de-sac), **spur** (amber: it turned round at a junction after an out-and-back)
and **mid-street** (red: it turned round on the street, or through a gap in a divided road). For each
one the tool says what the out-and-back stretch costs and whether cutting it would lose a street that no
other pass of the day covers (coverage is counted per mapped street piece, either direction).

Four modes: **Select** (inspect; `n` / `p` step through), **Cut** (click a spur to remove the out-and-back
stretch), **Reroute** (click A, then B further along: the stretch between is replaced by a legal path along
real streets with no U-turn, previewed in green with what it loses in red, `←` `→` choose another pass
of the same street for B), **Points** (click a point to select it, drag it to move it onto a street, click on the line to add a point;
Delete removes the selection and closes the gap along the street, Alt+Delete fills it with a legal detour).
In Cut mode the click lands where the car will turn back, so a spur can be shortened instead of dropped. The **Satellite** button (or `s`) puts Esri imagery under the street names, to see whether a spur
is a street, a yard or a car park. **Parking** (or `k`) draws the city's parking bays from
`data/parking.geojson` (pink: zone A, paid; teal: ALL) with the address and number of spaces of the bay
under the cursor; rebuild that file from the Tbilisi-Parking-Study shapefile with
`sh tools/build_parking.sh [path/to/parking_09.shp]` (needs GDAL). The tool warns about lost coverage, wrong-way pieces and banned turns but never blocks an edit;
every edit can be undone. **Save** writes `data/routes/<name>_clean.gpx` (the original is never changed):
a GPX with the planned points regenerated at every instruction and the track, which the app drives like
any other file. The OsmAnd routing block of the originals is not reproduced.

The editing logic is in `js/edit.js` and has no DOM: the document is the list of vertices as the engine
snapped them to the streets, and every edit is a new vertex list plus a rebuild (65 ms for a 177 km day).
Reroutes can only use streets within about 2.7 km of the day's bounding box.

## Running it locally

Any static server, e.g. `python3 -m http.server 8790`, then http://localhost:8790. The phone needs the
app on an `https://` address for GPS (any static host works; nothing runs on a server).

## Credits

Street data © OpenStreetMap contributors, available under the Open Database License (ODbL).
Map tiles: OpenFreeMap, OpenMapTiles. Map library: MapLibre GL JS (BSD-3-Clause, `vendor/`).
Fonts: Inter and Noto Sans Georgian (SIL Open Font License 1.1, `fonts/`).
