"""Build data/parking-lots.json: every parking lot of the Tbilisi parking survey, for the map layer.

Usage:  python3 -I tools/build_lots.py <doc.kml from parking-lots-navigator-app.kmz> data/parking-lots.json

The KML (Export_Output_Dissolve, from Zuka, 26 Nov 2026) holds the lot polygons dissolved into one
placemark per EL_DAMTENI value (EV chargers at the lot: 0, 1 or 2). Its LineStrings are slivers left
by the dissolve (all under 0.5 m across) and are dropped.

Output, compact: coordinates in millionths of a degree (about 0.1 m), each ring stored as its first
point relative to the origin and then the steps between points, without the closing point.
  { "o": [lon0, lat0], "lots": [[ev, x0, y0, dx1, dy1, dx2, dy2, ...], ...] }
js/lots.js turns it back into GeoJSON.
"""
import json, math, re, sys
import xml.etree.ElementTree as ET

NS = {"k": "http://www.opengis.net/kml/2.2"}
Q = 1e6

src, out = sys.argv[1], sys.argv[2]
doc = ET.parse(src).getroot().find("k:Document", NS)


def size_m(pts):
    lat = math.radians(pts[0][1])
    xs = [p[0] * 111320 * math.cos(lat) for p in pts]
    ys = [p[1] * 110540 for p in pts]
    return math.hypot(max(xs) - min(xs), max(ys) - min(ys))


lots, slivers, biggest_sliver = [], 0, 0.0
for pm in doc.findall("k:Placemark", NS):
    desc = pm.find("k:description", NS).text or ""
    ev = int(re.search(r"EL_DAMTENI\s+(\d+)", desc).group(1))
    for ls in pm.findall(".//k:LineString", NS):
        pts = [tuple(map(float, p.split(",")[:2])) for p in ls.find("k:coordinates", NS).text.split()]
        slivers += 1
        biggest_sliver = max(biggest_sliver, size_m(pts))
    for poly in pm.findall(".//k:Polygon", NS):
        if poly.find(".//k:innerBoundaryIs", NS) is not None:
            raise SystemExit("a lot with a hole: not expected")
        text = poly.find("k:outerBoundaryIs/k:LinearRing/k:coordinates", NS).text
        ring = []
        for p in text.split():
            x, y = (round(float(v) * Q) for v in p.split(",")[:2])
            if not ring or ring[-1] != (x, y):
                ring.append((x, y))
        if ring[0] == ring[-1]:
            ring.pop()
        if len(ring) < 3:
            raise SystemExit("a lot with fewer than 3 corners")
        lots.append((ev, ring))

if biggest_sliver > 0.5:
    raise SystemExit(f"a LineString is {biggest_sliver:.1f} m across: not a sliver, look at it")

ox = min(x for _, r in lots for x, _ in r)
oy = min(y for _, r in lots for _, y in r)
rows = []
for ev, ring in lots:
    row = [ev, ring[0][0] - ox, ring[0][1] - oy]
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        row += [x2 - x1, y2 - y1]
    rows.append(row)

with open(out, "w") as f:
    f.write('{"o":[%s,%s],"lots":[\n' % (ox / Q, oy / Q))
    f.write(",\n".join(json.dumps(r, separators=(",", ":")) for r in rows))
    f.write("\n]}\n")

by_ev = {}
for ev, _ in lots:
    by_ev[ev] = by_ev.get(ev, 0) + 1
print(f"{len(lots)} lots {dict(sorted(by_ev.items()))}, {slivers} slivers dropped (largest {biggest_sliver:.2f} m)")
