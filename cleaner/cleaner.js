// Route cleaner page: load a survey day, see every U-turn, edit the route, save a *_clean.gpx.
// All route logic is in ../js/edit.js (tested in Node); this file is the map and the panel.
import * as E from '../js/edit.js';

const STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const COLORS = { deadEnd: '#9ba1b2', spur: '#fbbf24', midStreet: '#f87171' };
const NIGHT = { bg: '#10121b', water: '#090b12', park: '#11161e', land: '#12141e', building: '#171a26', buildingLine: '#1d2030',
  motorway: '#3b405a', major: '#363b53', secondary: '#30354a', minor: '#2a2e41', service: '#242838', path: '#1c1f2c',
  casing: '#0d0f17', rail: '#1f2231', label: '#8d93a7', halo: '#0d0f17', waterLabel: '#4c5a82' };
const HINT = {
  select: 'Click a U-turn marker or a list row. n / p step through them.',
  cut: 'Hover a spur (orange) and click to remove the out-and-back stretch.',
  reroute: 'Click point A on the route, then point B further along: the stretch between is replaced by a legal, U-turn-free path.',
  points: 'Drag a vertex (Alt: no snapping). Click / shift-click to select a range, Delete removes it (Alt: plain fill).',
};
const $ = (id) => document.getElementById(id);
const km = (m) => (m / 1000).toFixed(2) + ' km';
const m0 = (m) => Math.round(m) + ' m';
const sign = (m) => (m > 0 ? '+' : m < 0 ? '−' : '') + m0(Math.abs(m));

let map, mapReady = false, doc = null, netDoc = null, files = [];
const S = {
  mode: 'select', sel: null, hover: null, markers: true, last: null,
  pick: { a: null, b: null, cands: [], ci: 0 }, preview: null,
  pts: { sel: new Set(), anchor: null, drag: null },
  filters: { deadEnd: true, spur: true, midStreet: true },
};

/* ------------------------------------------------------------------ start */

async function init() {
  if (navigator.serviceWorker) navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
  bindPanel();
  await refreshFiles();
  startMap();
  showLoading('Loading the street map…');
  try {
    netDoc = await (await fetch('../data/tbilisi-net.json')).json();
  } catch (e) { showLoading(null); toast('Could not load data/tbilisi-net.json: ' + e.message); return; }
  showLoading(null);
  const want = decodeURIComponent(location.hash.slice(1));
  const first = files.find((f) => f.file === want) || files.find((f) => !f.clean) || files[0];
  if (first) { $('fileSel').value = first.file; await loadFile(first.file); }
}

async function refreshFiles() {
  try {
    files = await (await fetch('/api/routes')).json();
  } catch { files = []; toast('The file list needs the cleaner server: node tools/cleaner_server.mjs'); }
  const sel = $('fileSel'), cur = sel.value;
  sel.innerHTML = '';
  for (const f of files) {
    const o = document.createElement('option');
    o.value = f.file; o.textContent = `${f.file}  (${(f.bytes / 1024).toFixed(0)} KB${f.hasClean ? ', has a clean copy' : ''})`;
    sel.appendChild(o);
  }
  if (cur && files.some((f) => f.file === cur)) sel.value = cur;
}

async function loadFile(file) {
  if (doc && doc.dirty && !window.confirmLeave) { /* keep it simple: the browser's beforeunload guards reloads; here we just warn */ toast('Unsaved edits were discarded by loading another file.'); }
  showLoading('Reading ' + file + '…');
  try {
    const text = await (await fetch('/api/routes/' + encodeURIComponent(file))).text();
    await new Promise((r) => setTimeout(r, 20));
    doc = E.openDoc(text, netDoc, { file });
  } catch (e) { showLoading(null); toast('Could not open ' + file + ': ' + e.message); return; }
  showLoading(null);
  location.hash = file;
  S.sel = null; S.hover = null; S.last = null; S.preview = null; resetPick(); S.pts.sel.clear(); S.pts.anchor = null;
  $('target').textContent = 'data/routes/' + E.cleanName(file);
  for (const id of ['btnSave', 'btnDownload', 'btnRevert']) $(id).disabled = false;
  renderAll();
  fitRoute();
}

/* ------------------------------------------------------------------ map */

function startMap() {
  map = new maplibregl.Map({ container: 'map', style: STYLE, center: [44.79, 41.72], zoom: 12, attributionControl: false, fadeDuration: 0, maxPitch: 0, pitchWithRotate: false });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.on('style.load', nightTheme);
  map.on('load', () => { calmMap(); addLayers(); mapReady = true; if (doc) { renderMap(); fitRoute(); } });
  map.on('click', onClick);
  map.on('mousemove', onMove);
  map.on('mousedown', onDown);
  map.on('mouseup', onUp);
  map.on('error', (e) => console.warn('map:', e && e.error && e.error.message));
  map.getContainer().classList.add('mode-select');
}

function nightTheme() {
  const C = NIGHT;
  for (const l of map.getStyle().layers) {
    const id = l.id, t = l.type, sl = l['source-layer'] || '';
    const set = (prop, v) => { try { map.setPaintProperty(id, prop, v); } catch { /* not on this layer */ } };
    const hide = () => map.setLayoutProperty(id, 'visibility', 'none');
    if (t === 'background') set('background-color', C.bg);
    else if (t === 'raster' || t === 'hillshade') hide();
    else if (t === 'fill') {
      if (sl === 'water') set('fill-color', C.water);
      else if (sl === 'building') { set('fill-color', C.building); set('fill-outline-color', C.buildingLine); }
      else if (id === 'road_area_pattern') hide();
      else if (sl === 'park' || /wood|grass|wetland/.test(id)) { set('fill-color', C.park); set('fill-opacity', 1); }
      else { set('fill-color', C.land); set('fill-opacity', 1); }
    } else if (t === 'line') {
      if (sl === 'waterway') set('line-color', C.water);
      else if (sl === 'boundary') hide();
      else if (sl === 'park') set('line-color', C.park);
      else if (sl === 'aeroway') set('line-color', C.service);
      else if (/casing/.test(id)) set('line-color', C.casing);
      else if (/rail|hatching/.test(id)) set('line-color', C.rail);
      else if (/motorway/.test(id)) set('line-color', C.motorway);
      else if (/trunk_primary/.test(id)) set('line-color', C.major);
      else if (/secondary_tertiary|_link/.test(id)) set('line-color', C.secondary);
      else if (/minor|street/.test(id)) set('line-color', C.minor);
      else if (/service_track/.test(id)) set('line-color', C.service);
      else if (/path_pedestrian/.test(id)) set('line-color', C.path);
      else set('line-color', C.minor);
    } else if (t === 'symbol') {
      set('text-color', /water/.test(id) ? C.waterLabel : C.label);
      set('text-halo-color', C.halo); set('text-halo-width', 1.2);
      if (/one_way/.test(id)) set('icon-opacity', 0.3);
    }
  }
}

function calmMap() {
  for (const l of map.getStyle().layers) {
    if (l.type === 'fill-extrusion' || (l.type === 'symbol' && l['source-layer'] === 'poi')) map.setLayoutProperty(l.id, 'visibility', 'none');
  }
}

function makeIcon(draw, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  draw(g, size);
  return { width: size, height: size, data: g.getImageData(0, 0, size, size).data };
}

const EMPTY = { type: 'FeatureCollection', features: [] };
function addLayers() {
  map.addImage('chev', makeIcon((g, s) => {
    g.lineWidth = 5; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#ffffff';
    g.beginPath(); g.moveTo(s * 0.32, s * 0.24); g.lineTo(s * 0.62, s * 0.5); g.lineTo(s * 0.32, s * 0.76); g.stroke();
  }, 32), { pixelRatio: 2 });
  for (const id of ['route', 'spur', 'lost', 'preview', 'verts', 'uturns', 'picks', 'drag']) map.addSource(id, { type: 'geojson', data: EMPTY });
  const layers = map.getStyle().layers;
  const firstLabel = (layers.find((l) => l.type === 'symbol' && l['source-layer'] === 'transportation_name')
    || layers.find((l) => l.type === 'symbol' && l['source-layer'] === 'place') || {}).id;
  const zw = (a, b) => ['interpolate', ['exponential', 1.6], ['zoom'], 13, a, 18, b];
  const line = (id, src, color, width, paint = {}, before = firstLabel) => map.addLayer({
    id, type: 'line', source: src, layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': color, 'line-width': width, ...paint },
  }, before);
  line('route-glow', 'route', '#8b5cf6', zw(6, 20), { 'line-blur': zw(4, 12), 'line-opacity': 0.35 });
  line('route', 'route', '#3d7bff', zw(2.2, 7));
  map.addLayer({
    id: 'route-chev', type: 'symbol', source: 'route', minzoom: 14,
    layout: { 'symbol-placement': 'line', 'symbol-spacing': 60, 'icon-image': 'chev', 'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.5, 18, 1], 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map', 'icon-keep-upright': false },
    paint: { 'icon-opacity': 0.5 },
  }, firstLabel);
  line('spur', 'spur', '#fb923c', zw(5, 15), { 'line-opacity': 0.9 }, undefined);
  line('lost', 'lost', '#f87171', zw(4, 12), { 'line-dasharray': [1.2, 1.2] }, undefined);
  line('preview-glow', 'preview', '#4ade80', zw(8, 24), { 'line-blur': zw(4, 12), 'line-opacity': 0.4 }, undefined);
  line('preview', 'preview', '#4ade80', zw(3.5, 10), { 'line-dasharray': [2, 1] }, undefined);
  map.addLayer({ id: 'verts', type: 'circle', source: 'verts', minzoom: 15, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 15, 2.5, 18, 5], 'circle-color': ['case', ['>=', ['get', 'node'], 0], '#f2f3f7', '#9ba1b2'], 'circle-stroke-color': '#0d0f17', 'circle-stroke-width': 1 } });
  map.addLayer({ id: 'verts-sel', type: 'circle', source: 'verts', filter: ['==', ['get', 'sel'], 1], paint: { 'circle-radius': 7, 'circle-color': '#8b7cf6', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'drag', type: 'circle', source: 'drag', paint: { 'circle-radius': 8, 'circle-color': '#fbbf24', 'circle-stroke-color': '#0d0f17', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'uturns', type: 'circle', source: 'uturns', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4, 16, 9], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0d0f17', 'circle-stroke-width': 1.5 } });
  map.addLayer({ id: 'uturns-sel', type: 'circle', source: 'uturns', filter: ['==', ['get', 'sel'], 1], paint: { 'circle-radius': 16, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#8b7cf6', 'circle-stroke-width': 3 } });
  map.addLayer({ id: 'picks', type: 'circle', source: 'picks', paint: { 'circle-radius': 10, 'circle-color': '#4ade80', 'circle-stroke-color': '#0d0f17', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'picks-label', type: 'symbol', source: 'picks', layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': true }, paint: { 'text-color': '#0d0f17' } });
  map.on('mouseenter', 'uturns', () => { if (S.mode === 'select') map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'uturns', () => { map.getCanvas().style.cursor = ''; });
}

const toXY = (lngLat) => doc.proj.toXY(lngLat.lat, lngLat.lng);
const coordsOf = (route, i0, i1) => { const out = []; for (let i = i0; i <= i1; i++) out.push([route.lon[i], route.lat[i]]); return out; };
const lineFeature = (coords) => (coords.length > 1 ? { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } } : null);
const fc = (features) => ({ type: 'FeatureCollection', features: features.filter(Boolean) });
const setData = (id, data) => { if (mapReady) map.getSource(id).setData(data); };
// Picking tolerance in metres: a dozen screen pixels
const tol = () => Math.max(5, 12 * 156543.03 * Math.cos((map.getCenter().lat * Math.PI) / 180) / 2 ** map.getZoom());

function renderMap() {
  if (!mapReady || !doc) return;
  const r = doc.route;
  setData('route', fc([lineFeature(coordsOf(r, 0, r.X.length - 1))]));
  const vis = (u) => S.markers && S.filters[u.type];
  setData('uturns', fc(doc.uturns.filter(vis).map((u) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [u.lon, u.lat] }, properties: { k: u.k, color: COLORS[u.type], sel: u.k === S.sel ? 1 : 0 } }))));
  const ext = S.mode === 'cut' && S.hover != null ? doc.uturns[S.hover] : S.sel != null ? doc.uturns[S.sel] : null;
  setData('spur', fc([ext && ext.K > 0 ? lineFeature(coordsOf(r, ext.a, ext.b)) : null]));
  const lost = S.preview ? S.preview.coverage.lost : S.last && S.last.coverage ? S.last.coverage.lost : ext ? ext.verdict.lost : [];
  setData('lost', fc(lost.map((l) => segLine(l.s))));
  setData('preview', fc([S.preview ? lineFeature(pointsCoords(S.preview.path)) : null]));
  const picks = [];
  if (S.pick.a != null) picks.push(pickFeature(S.pick.a, 'A'));
  if (S.pick.b != null) picks.push(pickFeature(S.pick.b, 'B'));
  setData('picks', fc(picks));
  setData('verts', S.mode === 'points' ? fc(Array.from(r.X, (_, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon[i], r.lat[i]] }, properties: { i, node: r.node[i], sel: S.pts.sel.has(i) ? 1 : 0 } }))) : EMPTY);
  if (!S.pts.drag) setData('drag', EMPTY);
}
const pointsCoords = (path) => Array.from(path.lat, (la, i) => [path.lon[i], la]);
const pickFeature = (i, label) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [doc.route.lon[i], doc.route.lat[i]] }, properties: { label } });
function segLine(s) {
  const net = doc.net, [la1, lo1] = doc.proj.toLL(net.X[net.sA[s]], net.Y[net.sA[s]]), [la2, lo2] = doc.proj.toLL(net.X[net.sB[s]], net.Y[net.sB[s]]);
  return lineFeature([[lo1, la1], [lo2, la2]]);
}
function fitRoute() {
  if (!mapReady || !doc) return;
  const [w, s, e, n] = doc.route.bbox || bboxOf(doc.route);
  map.fitBounds([[w, s], [e, n]], { padding: { top: 40, bottom: 40, left: 420, right: 40 }, duration: 600 });
}
function bboxOf(r) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (let i = 0; i < r.X.length; i++) { if (r.lon[i] < w) w = r.lon[i]; if (r.lon[i] > e) e = r.lon[i]; if (r.lat[i] < s) s = r.lat[i]; if (r.lat[i] > n) n = r.lat[i]; }
  return [w, s, e, n];
}
function flyToVertex(i, zoom = 17) {
  if (!mapReady) return;
  map.flyTo({ center: [doc.route.lon[i], doc.route.lat[i]], zoom: Math.max(map.getZoom(), zoom), padding: { left: 400 }, duration: 700 });
}

/* ------------------------------------------------------------------ map interaction */

function uturnAt(x, y) {
  for (const { i } of E.verticesNear(doc, x, y, tol() * 1.5)) {
    const u = doc.uturns.find((v) => v.K > 0 && v.a <= i && i <= v.b);
    if (u) return u;
  }
  return null;
}

// Passes of the route near a point, after vertex `after`: one candidate per pass, nearest first
function passesNear(x, y, after) {
  const out = [];
  for (const { i } of E.verticesNear(doc, x, y, tol() * 2)) {
    if (i <= after || doc.route.node[i] < 0) continue;
    if (out.every((j) => Math.abs(j - i) > 8)) out.push(i);
  }
  return out;
}

// The vertex under the cursor. Where the route passes the same spot more than once there are
// several vertices on top of each other: repeated clicks cycle through the passes.
function pickVertex(x, y) {
  const near = E.verticesNear(doc, x, y, tol());
  if (!near.length) return -1;
  const same = near.filter((v) => v.d <= near[0].d + 0.5).map((v) => v.i).sort((p, q) => p - q);
  const at = same.indexOf(S.pts.anchor);
  const i = at >= 0 ? same[(at + 1) % same.length] : same[0];
  if (same.length > 1) toast(`${same.length} passes of the route meet here: pass ${same.indexOf(i) + 1} (km ${(doc.route.along[i] / 1000).toFixed(2)}) selected, click again for the next.`);
  return i;
}

function onClick(e) {
  if (!doc || S.pts.drag) return;
  const [x, y] = toXY(e.lngLat);
  if (S.mode === 'select') {
    const f = map.queryRenderedFeatures(e.point, { layers: ['uturns'] });
    if (f.length) return select(f[0].properties.k);
    const u = uturnAt(x, y);
    if (u) select(u.k);
  } else if (S.mode === 'cut') {
    const u = uturnAt(x, y);
    if (u) doCut(u); else toast('No spur under the cursor.');
  } else if (S.mode === 'reroute') {
    if (S.pick.a == null) {
      const i = E.nearestVertex(doc, x, y, { nodeOnly: true, tol: tol() * 2 });
      if (i < 0) return toast('Click on the route to set point A.');
      S.pick.a = i; renderAll();
    } else if (S.pick.b == null || S.preview) {
      const c = passesNear(x, y, S.pick.a);
      if (!c.length) return toast('Point B must be on the route after A.');
      S.pick.cands = c; S.pick.ci = 0; S.pick.b = c[0];
      makePreview();
    }
  } else if (S.mode === 'points') {
    const i = pickVertex(x, y);
    if (i < 0) { S.pts.sel.clear(); S.pts.anchor = null; }
    else if (e.originalEvent.shiftKey && S.pts.anchor != null) { S.pts.sel.clear(); for (let k = Math.min(S.pts.anchor, i); k <= Math.max(S.pts.anchor, i); k++) S.pts.sel.add(k); }
    else { S.pts.sel.clear(); S.pts.sel.add(i); S.pts.anchor = i; }
    renderAll();
  }
}

let moveQueued = false;
function onMove(e) {
  if (!doc) return;
  if (S.pts.drag) {
    setData('drag', fc([{ type: 'Feature', geometry: { type: 'Point', coordinates: [e.lngLat.lng, e.lngLat.lat] } }]));
    return;
  }
  if (S.mode !== 'cut' || moveQueued) return;
  moveQueued = true;
  requestAnimationFrame(() => {
    moveQueued = false;
    const [x, y] = toXY(e.lngLat), u = uturnAt(x, y), k = u ? u.k : null;
    if (k !== S.hover) { S.hover = k; renderMap(); map.getCanvas().style.cursor = u ? 'pointer' : ''; }
  });
}

function onDown(e) {
  if (!doc || S.mode !== 'points' || e.originalEvent.button !== 0) return;
  const [x, y] = toXY(e.lngLat);
  const i = S.pts.anchor != null && E.verticesNear(doc, x, y, tol()).some((v) => v.i === S.pts.anchor) ? S.pts.anchor : E.nearestVertex(doc, x, y, { tol: tol() });
  if (i < 0) return;
  S.pts.drag = { i, alt: e.originalEvent.altKey };
  map.dragPan.disable();
  map.getContainer().classList.add('dragging');
}

function onUp(e) {
  const d = S.pts.drag;
  if (!d) return;
  S.pts.drag = null;
  map.dragPan.enable();
  map.getContainer().classList.remove('dragging');
  const res = E.movePoint(doc, d.i, e.lngLat.lat, e.lngLat.lng, { snap: !(d.alt || e.originalEvent.altKey) });
  if (!res) return renderMap();
  S.pts.sel.clear(); S.pts.sel.add(d.i); S.pts.anchor = d.i;
  afterEdit(res, res.legality.offStreet > 1 ? `Point moved, ${m0(res.legality.offStreet)} off the street map.` : 'Point moved. ' + legalityText(res.legality));
}

/* ------------------------------------------------------------------ edits */

function select(k, fly = true) {
  S.sel = k; S.hover = null;
  renderAll();
  if (fly && k != null) flyToVertex(doc.uturns[k].i);
  const row = document.querySelector(`#list li[data-k="${k}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

function doCut(u) {
  const res = E.cutSpur(doc, u);
  if (!res) return toast('This U-turn has no out-and-back stretch to cut; use Reroute.');
  const lost = res.coverage.lostMeters;
  afterEdit(res, `Cut spur at ${km(u.along)}: ${sign(res.deltaMeters)}. ` + (lost >= 1 ? `Loses ${m0(lost)} of ${res.coverage.lost.map((l) => l.name).filter((v, i, a) => a.indexOf(v) === i).join(', ')}.` : 'Every street is still driven elsewhere.') + (res.seam && res.seam.banned ? ' Warning: the join is a banned turn.' : ''), true);
}

function rerouteAround(u) {
  const r = doc.route, n = r.X.length;
  let a = u.a; while (a > 0 && (r.node[a] < 0 || r.along[u.a] - r.along[a] < 60)) a--;
  let b = u.b; while (b < n - 1 && (r.node[b] < 0 || r.along[b] - r.along[u.b] < 60)) b++;
  setMode('reroute');
  S.pick.a = a; S.pick.b = b; S.pick.cands = [b]; S.pick.ci = 0;
  makePreview();
}

function makePreview() {
  S.preview = E.previewReroute(doc, S.pick.a, S.pick.b);
  if (!S.preview) toast('No legal path between A and B within the street map. Try other points.');
  renderAll();
}

function applyPreview() {
  if (!S.preview) return;
  const res = E.reroute(doc, S.pick.a, S.pick.b);
  if (!res) return toast('The reroute could not be applied.');
  afterEdit(res, `Rerouted: ${sign(res.deltaMeters)}, ${res.uturnsBefore - res.uturnsAfter} U-turn(s) fewer. ` + coverageText(res.coverage) + ' ' + legalityText(res.legality), true);
}

function deleteSelection(alt) {
  if (!S.pts.sel.size) return;
  const idx = [...S.pts.sel].sort((p, q) => p - q);
  const res = E.deletePoints(doc, idx[0], idx[idx.length - 1], { legal: !alt });
  if (!res) return toast('Those points cannot be deleted (the route must keep its start and end).');
  S.pts.sel.clear(); S.pts.anchor = null;
  afterEdit(res, `Deleted ${idx.length} point(s): ${sign(res.deltaMeters)}. ` + coverageText(res.coverage) + ' ' + legalityText(res.legality), true);
}

function coverageText(c) {
  if (!c) return '';
  const parts = [];
  if (c.lostMeters >= 1) parts.push(`loses ${m0(c.lostMeters)} of ${[...new Set(c.lost.map((l) => l.name))].slice(0, 3).join(', ')}`);
  if (c.gainedMeters >= 1) parts.push(`adds ${m0(c.gainedMeters)} of new streets`);
  return parts.length ? parts.join('; ') + '.' : 'Every street is still driven elsewhere.';
}
function legalityText(l) {
  if (!l) return '';
  const parts = [];
  if (l.wrongWay.length) parts.push(`${l.wrongWay.length} wrong-way piece(s)`);
  if (l.banned.length) parts.push(`${l.banned.length} banned turn(s)`);
  if (l.offStreet > 1) parts.push(`${m0(l.offStreet)} off the street map`);
  return parts.length ? 'Warning: ' + parts.join(', ') + '.' : '';
}

function afterEdit(res, message, undoable = false) {
  S.last = res; S.preview = null; resetPick();
  const prev = S.sel != null ? doc.uturns[S.sel] : null;      // the list is rebuilt: find the same U-turn by position
  S.sel = null; S.hover = null;
  if (prev) {
    const [px, py] = doc.proj.toXY(prev.lat, prev.lon);
    let best = null, bd = 30;
    for (const u of doc.uturns) { const [ux, uy] = doc.proj.toXY(u.lat, u.lon); const d = Math.hypot(ux - px, uy - py); if (d < bd) { bd = d; best = u; } }
    if (best) S.sel = best.k;
  }
  renderAll();
  if (message) toast(message, undoable ? doUndo : null);
}

function doUndo() { if (E.undo(doc)) { S.last = null; S.preview = null; resetPick(); S.pts.sel.clear(); hideToast(); renderAll(); } }
function doRedo() { if (E.redo(doc)) { S.last = null; S.preview = null; resetPick(); S.pts.sel.clear(); hideToast(); renderAll(); } }
function resetPick() { S.pick = { a: null, b: null, cands: [], ci: 0 }; }

function setMode(mode) {
  if (S.mode === mode) return;
  S.mode = mode; S.hover = null; S.preview = null; resetPick(); S.pts.sel.clear(); S.pts.anchor = null;
  const c = map.getContainer().classList;
  for (const m of ['select', 'cut', 'reroute', 'points']) c.toggle('mode-' + m, m === mode);
  map.getCanvas().style.cursor = '';
  renderAll();
}

/* ------------------------------------------------------------------ saving */

async function save() {
  if (!doc) return;
  const name = E.cleanName(doc.file), text = E.writeGpx(doc);
  try {
    const r = await fetch('/api/routes/' + encodeURIComponent(name), { method: 'PUT', body: text });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.statusText);
    doc.savedPoints = doc.points; doc.dirty = false;
    toast(`Saved ${body.path} (${(body.bytes / 1024).toFixed(0)} KB).`);
    await refreshFiles();
    renderAll();
  } catch (e) {
    toast(`Could not save on the server (${e.message}); downloading instead.`);
    download(name, text);
  }
}

function download(name, text = E.writeGpx(doc)) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/gpx+xml' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function revert() {
  if (!doc || !doc.history.length && !doc.dirty) return toast('Nothing to revert.');
  const res = E.commit(doc, 'revert to the file', doc.original.points);
  afterEdit(res, 'Back to the file as loaded.', true);
}

/* ------------------------------------------------------------------ panel */

function bindPanel() {
  $('btnLoad').addEventListener('click', () => loadFile($('fileSel').value));
  $('fileSel').addEventListener('change', () => loadFile($('fileSel').value));
  for (const b of document.querySelectorAll('.mode')) b.addEventListener('click', () => setMode(b.dataset.mode));
  for (const t of Object.keys(S.filters)) $('f-' + t).addEventListener('change', (e) => { S.filters[t] = e.target.checked; renderAll(); });
  $('btnUndo').addEventListener('click', doUndo);
  $('btnRedo').addEventListener('click', doRedo);
  $('btnSave').addEventListener('click', save);
  $('btnDownload').addEventListener('click', () => download(E.cleanName(doc.file)));
  $('btnRevert').addEventListener('click', revert);
  $('toastBtn').addEventListener('click', () => { if (toastAction) toastAction(); hideToast(); });
  $('list').addEventListener('click', (e) => { const li = e.target.closest('li[data-k]'); if (li) select(+li.dataset.k); });
  $('selCard').addEventListener('click', onCardClick);
  $('previewCard').addEventListener('click', onCardClick);
  window.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', (e) => { if (doc && doc.dirty) { e.preventDefault(); e.returnValue = ''; } });
}

function onCardClick(e) {
  const b = e.target.closest('button[data-act]');
  if (!b || !doc) return;
  const u = S.sel != null ? doc.uturns[S.sel] : null;
  switch (b.dataset.act) {
    case 'cut': if (u) doCut(u); break;
    case 'around': if (u) rerouteAround(u); break;
    case 'fly': if (u) flyToVertex(u.i); break;
    case 'apply': applyPreview(); break;
    case 'cancel': S.preview = null; resetPick(); renderAll(); break;
    case 'prevB': cycleB(-1); break;
    case 'nextB': cycleB(1); break;
  }
}

function cycleB(dir) {
  const c = S.pick.cands;
  if (c.length < 2) return;
  S.pick.ci = (S.pick.ci + dir + c.length) % c.length;
  S.pick.b = c[S.pick.ci];
  makePreview();
}

function onKey(e) {
  if (!doc) return;
  const t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if (typing || mod) return;
  const u = S.sel != null ? doc.uturns[S.sel] : null;
  const visible = doc.uturns.filter((v) => S.filters[v.type]);
  switch (e.key) {
    case '1': setMode('select'); break;
    case '2': setMode('cut'); break;
    case '3': setMode('reroute'); break;
    case '4': setMode('points'); break;
    case 'n': case 'N': case 'j': { if (!visible.length) break; const k = visible.findIndex((v) => v.k === S.sel); select(visible[(k + 1) % visible.length].k); break; }
    case 'p': case 'P': case 'k': { if (!visible.length) break; const k = visible.findIndex((v) => v.k === S.sel); select(visible[(k - 1 + visible.length) % visible.length].k); break; }
    case 'x': case 'X': if (u) doCut(u); break;
    case 'r': case 'R': if (u) rerouteAround(u); break;
    case 'f': case 'F': fitRoute(); break;
    case 'u': case 'U': S.markers = !S.markers; renderMap(); break;
    case 'ArrowLeft': if (S.mode === 'reroute') { e.preventDefault(); cycleB(-1); } break;
    case 'ArrowRight': if (S.mode === 'reroute') { e.preventDefault(); cycleB(1); } break;
    case 'Enter': if (S.preview) { e.preventDefault(); applyPreview(); } break;
    case 'Escape':
      if (S.preview || S.pick.a != null) { S.preview = null; resetPick(); renderAll(); }
      else if (S.pts.sel.size) { S.pts.sel.clear(); S.pts.anchor = null; renderAll(); }
      else if (S.mode !== 'select') setMode('select');
      else if (S.sel != null) { S.sel = null; renderAll(); }
      hideToast();
      break;
    case 'Delete': case 'Backspace': if (S.mode === 'points') { e.preventDefault(); deleteSelection(e.altKey); } break;
    default: return;
  }
}

function renderAll() {
  if (!doc) return;
  renderStats(); renderList(); renderSelection(); renderPreview(); renderHistory(); renderMap();
  $('modeHint').textContent = HINT[S.mode];
  for (const b of document.querySelectorAll('.mode')) b.classList.toggle('on', b.dataset.mode === S.mode);
  $('dirty').hidden = !doc.dirty;
  document.title = (doc.dirty ? '• ' : '') + doc.file + ' — Route cleaner';
}

function renderStats() {
  const r = doc.route, o = doc.original, counts = { deadEnd: 0, spur: 0, midStreet: 0 };
  for (const u of doc.uturns) counts[u.type]++;
  const d = r.total - o.total, du = doc.uturns.length - o.uturnCount, safe = doc.uturns.filter((u) => u.verdict.ok && u.K > 0).length;
  const delta = (v, unit, worseIfUp = true) => v === 0 ? '' : `<span class="delta${(v > 0) === worseIfUp ? ' worse' : ''}">${v > 0 ? '+' : '−'}${unit(Math.abs(v))}</span>`;
  $('stats').hidden = false;
  $('stats').innerHTML = `
    <div><span>length</span><b>${km(r.total)} ${delta(d, m0)}</b></div>
    <div><span>U-turns</span><b>${doc.uturns.length} ${delta(du, String)}</b></div>
    <div><span>safe to cut</span><b>${safe}</b></div>
    <div><span>vertices</span><b>${r.X.length}</b></div>
    <div class="wide"><span>on mapped streets</span><b>${(r.matched * 100).toFixed(2)} %</b></div>`;
  for (const t of Object.keys(counts)) $('c-' + t).textContent = counts[t];
}

function renderList() {
  const list = $('list'), rows = doc.uturns.filter((u) => S.filters[u.type]);
  if (!rows.length) { list.innerHTML = '<li class="empty">No U-turns to show</li>'; return; }
  list.innerHTML = rows.map((u) => `
    <li data-k="${u.k}" class="${u.k === S.sel ? 'on' : ''}">
      <span class="km">${km(u.along)}</span>
      <span class="street"><i class="dot ${u.type}"></i>${escapeHtml(u.name || '(no name)')}</span>
      <span class="v ${u.K > 0 ? (u.verdict.ok ? 'ok' : 'warn') : ''}">${u.K > 0 ? (u.verdict.ok ? 'safe' : '−' + m0(u.verdict.lostMeters)) : ''}</span>
      <span class="sub">${u.K > 0 ? `spur ${m0(u.spurMeters)} out, ${m0(u.loopMeters)} round trip` : u.mergedTo != null ? 'turns through a gap in a divided road' : 'turns round on the street'}</span>
    </li>`).join('');
}

function renderSelection() {
  const card = $('selCard'), u = S.sel != null ? doc.uturns[S.sel] : null;
  card.hidden = !u;
  if (!u) return;
  const v = u.verdict;
  card.innerHTML = `
    <h2><span class="type ${u.type}">${label(u.type)}</span> ${km(u.along)} · ${escapeHtml(u.name || '(no name)')}</h2>
    <div class="meta">
      ${u.K > 0 ? `Out-and-back of <b>${m0(u.spurMeters)}</b> (${m0(u.loopMeters)} driven for it), retracing ${u.K} street piece(s)${u.partial ? ', ending mid-block' : ''}.` : u.mergedTo != null ? 'Two sharp turns through a gap in a divided road.' : 'The route turns round here without retracing a mapped street piece.'}<br>
      ${u.K > 0 ? (v.ok ? '<span class="ok">Cutting it loses no street: everything here is driven elsewhere.</span>' : `<span class="warn">Cutting it loses ${m0(v.lostMeters)} that no other pass covers:</span><ul>${v.lost.slice(0, 6).map((l) => `<li>${escapeHtml(l.name)} ${m0(l.meters)}</li>`).join('')}${v.lost.length > 6 ? `<li>… ${v.lost.length - 6} more</li>` : ''}</ul>`) : ''}
    </div>
    <div class="actions">
      ${u.K > 0 ? '<button class="btn small primary" data-act="cut">Cut spur <kbd>x</kbd></button>' : ''}
      <button class="btn small" data-act="around">Reroute around <kbd>r</kbd></button>
      <button class="btn small quiet" data-act="fly">Fly to</button>
    </div>`;
}

function renderPreview() {
  const card = $('previewCard');
  const show = S.mode === 'reroute' && (S.pick.a != null || S.preview);
  card.hidden = !show;
  if (!show) return;
  const p = S.preview;
  if (!p) {
    card.innerHTML = `<h2>Reroute</h2><div class="meta">A at ${km(doc.route.along[S.pick.a])}. Now click point B further along the route.</div>
      <div class="actions"><button class="btn small quiet" data-act="cancel">Cancel <kbd>Esc</kbd></button></div>`;
    return;
  }
  const c = p.coverage, l = p.legality, n = S.pick.cands.length;
  card.innerHTML = `
    <h2>Reroute preview</h2>
    <div class="meta">
      ${km(doc.route.along[S.pick.a])} → ${km(doc.route.along[S.pick.b])}${n > 1 ? ` · pass ${S.pick.ci + 1} of ${n} <button class="btn small quiet" data-act="prevB">←</button><button class="btn small quiet" data-act="nextB">→</button>` : ''}<br>
      Length <b>${sign(p.deltaMeters)}</b>, U-turns <b>${p.uturnsBefore} → ${p.uturnsAfter}</b>${p.uturnsInside.length ? ` <span class="bad">(${p.uturnsInside.length} inside the new stretch)</span>` : ''}.<br>
      ${c.lostMeters >= 1 ? `<span class="warn">Loses ${m0(c.lostMeters)}:</span><ul>${c.lost.slice(0, 6).map((x) => `<li>${escapeHtml(x.name)} ${m0(x.meters)}</li>`).join('')}</ul>` : '<span class="ok">No street is lost.</span>'}
      ${c.gainedMeters >= 1 ? `<br>Adds ${m0(c.gainedMeters)} of streets not driven before.` : ''}
      ${l.wrongWay.length || l.banned.length || l.offStreet > 1 ? `<br><span class="bad">${legalityText(l)}</span>` : ''}
    </div>
    <div class="actions">
      <button class="btn small primary" data-act="apply">Apply <kbd>Enter</kbd></button>
      <button class="btn small quiet" data-act="cancel">Cancel <kbd>Esc</kbd></button>
    </div>`;
}

function renderHistory() {
  $('btnUndo').disabled = !doc.history.length;
  $('btnRedo').disabled = !doc.future.length;
  const h = doc.history[doc.history.length - 1];
  $('histLabel').textContent = h ? `${doc.history.length} edit(s) · last: ${h.label}` : 'no edits yet';
}

const label = (t) => ({ deadEnd: 'dead end', spur: 'spur', midStreet: 'mid-street' })[t] || t;
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ------------------------------------------------------------------ toast, loading */

let toastTimer = null, toastAction = null;
function toast(text, action = null) {
  $('toastText').textContent = text;
  toastAction = action;
  $('toastBtn').hidden = !action;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 9000 : 6000);
}
function hideToast() { $('toast').hidden = true; toastAction = null; }
function showLoading(text) { $('loading').hidden = !text; if (text) $('loadingText').textContent = text; }

// For the browser console and the browser test: the live document, map and state
window.cleaner = { get doc() { return doc; }, get map() { return map; }, S, E };

init();
