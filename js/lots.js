// The parking lots of the Tbilisi survey (data/parking-lots.json, built by tools/build_lots.py):
// all 3,259 of them, shown on the map at all times so the driver sees where each lot is and on which
// side of the street.

export const LOTS_FILE = 'data/parking-lots.json';

// The compact file back to GeoJSON: one polygon per lot, with ev = EV chargers at the lot (0, 1, 2)
export function lotsToGeoJSON(data) {
  const Q = 1e6, ox = Math.round(data.o[0] * Q), oy = Math.round(data.o[1] * Q);
  const features = data.lots.map((row) => {
    let x = ox + row[1], y = oy + row[2];
    const ring = [[x / Q, y / Q]];
    for (let i = 3; i < row.length; i += 2) {
      x += row[i]; y += row[i + 1];
      ring.push([x / Q, y / Q]);
    }
    ring.push(ring[0]);
    return { type: 'Feature', properties: { ev: row[0] }, geometry: { type: 'Polygon', coordinates: [ring] } };
  });
  return { type: 'FeatureCollection', features };
}

export async function loadLots() {
  const r = await fetch(LOTS_FILE);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return lotsToGeoJSON(await r.json());
}
