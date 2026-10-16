// STS NAV (Survey Navigator): the phone app around js/core.js (screens, map, GPS, voice, saving progress).
import { prepare, Navigator, slice, pointAt, hashText, bearing, angleDiff } from './core.js';
import { SimCar } from './sim.js';
import { STR, speech } from './i18n.js';
import { arrowSvg, UI, CAR_SVG } from './icons.js';
import { SURVEY_DAYS, loadSurveyDay } from './days.js';
import { VOICE_DIR, VOICE_CLIPS, clipsFor, gapAfter } from './voice.js';

const APP_VERSION = '1.5.7 (17 Oct 2026)';
const NET_URL = 'data/tbilisi-net.json';
const STYLE = 'https://tiles.openfreemap.org/styles/liberty';      // recoloured to the night design on load
const TILEJSON = 'https://tiles.openfreemap.org/planet';
const NEAR = 320, AHEAD = 1500;          // metres of route drawn bold / drawn at all ahead of the car

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* ------------------------------------------------------------------ saved state (this phone only) */

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};
const K = { route: 'sn1.route', settings: 'sn1.settings', prog: (h) => 'sn1.prog.' + h, trace: (h) => 'sn1.trace.' + h, dayMeta: 'sn1.daymeta' };

// Screens in Georgian only. The voice is a choice (since 1.5.4): the recorded Georgian clips ('ka', the
// default) or the phone's own English voice ('en'). The older 'voice' setting of 1.3 is not used any more.
const settings = Object.assign({ showAll: false, muted: false }, store.get(K.settings, {}), { lang: 'ka' });
delete settings.voice;
if (settings.voiceLang !== 'en') settings.voiceLang = 'ka';
const saveSettings = () => store.set(K.settings, settings);
const T = STR.ka;

/* ------------------------------------------------------------------ app state */

let netPromise = null;
let day = null;                 // { text, hash, name, proj, net, route }
let nav = null;
let map = null, mapLoaded = null, mapReady = false, carMarker = null;
let screen = 'home', follow = true, followTimer = null;
let watchId = null, wakeLock = null, gpsBlocked = false;
let sim = null, simTimer = null, simMult = 4, simClock = 0, simFed = -1, simBackup = null;
let lastSnap = null, lastRawFix = null, lastFixReal = 0, cov = null, covAt = 0, saveAt = 0, traceAt = 0;
let trace = [], moving = { secs: 0, dist: 0, prev: null };
let toastTimer = null, paused = false, easeUntil = 0;
let dayPickerOpen = false;

/* ------------------------------------------------------------------ street map + route */

function loadNetwork() {
  if (!netPromise) {
    netPromise = fetch(NET_URL)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch((e) => { console.warn('street network not available', e); netPromise = null; return null; });
  }
  return netPromise;
}

async function openDay(text, persist = true, name = null) {
  const netDoc = await loadNetwork();
  const p = prepare(text, netDoc);
  day = { text, hash: hashText(text), name: name || p.gpx.name || T.appName, proj: p.proj, net: p.net, route: p.route };
  nav = null; trace = store.get(K.trace(day.hash), []) || [];
  if (persist) store.set(K.route, { text, name: day.name, at: Date.now() });
  warmOffline(day.route.bbox);
  return day;
}

function savedProgress() { return day ? store.get(K.prog(day.hash), null) : null; }

function makeNav(restore = true) {
  const n = new Navigator(day.route, day.net, day.proj);
  if (restore) n.restore(savedProgress());
  return n;
}

/* ------------------------------------------------------------------ start screen */

const brandHtml = () => `<header class="brand"><img src="icons/logo.png" alt="STS NAV" width="172" height="99"><p>${T.tagline}</p></header>`;
const errHtml = (msg) => (msg ? `<div class="errnote" role="alert"><b>!</b><span>${esc(msg)}</span></div>` : '');
const loadingHtml = (text) => `<div class="wrap">${brandHtml()}<div class="loading" role="status"><span class="spinner"></span><span>${text}</span></div></div>`;

function renderHome(msg = '') {
  screen = 'home';
  const h = $('home');
  h.hidden = false; $('navUi').hidden = true;
  if (!day) dayPickerOpen = true;                    // nothing loaded: the days are the first thing to see
  const foot = `<p class="credits">${T.about} · ${T.version} ${APP_VERSION}</p>`;
  const picker = `<section id="dayChoices" ${dayPickerOpen ? '' : 'hidden'}><h1 class="title">${T.chooseDay}</h1>${dayTiles()}</section>`;
  if (!day) {
    h.innerHTML = `<div class="wrap">${brandHtml()}${errHtml(msg)}${picker}<button class="btn quiet" id="hOpen">${T.openFile}</button>${voiceRow()}${foot}</div>`;
  } else {
    const r = day.route, prog = savedProgress();
    const started = prog && prog.along > 20;
    let progHtml = '';
    if (started) {
      const n = makeNav(), c = n.coverage();
      progHtml = `<div><div class="prog-line">${T.progress((prog.along / 1000).toFixed(1), (r.total / 1000).toFixed(1), Math.round(prog.along / r.total * 100))}</div>
        <div class="prog-missed${c.missed.length ? '' : ' none'}">${T.missedSummary(c.missed.length, T.dist(c.missedMeters))}</div></div>`;
    }
    h.innerHTML = `<div class="wrap">${brandHtml()}${errHtml(msg)}
      <div class="daycard">
        <div><h2>${esc(day.name)}</h2>
          <p class="meta">${T.stats((r.total / 1000).toFixed(1), r.maneuvers.length - 1)}</p>
          <p class="meta small">${day.net ? T.matched((r.matched * 100).toFixed(1)) : `<span class="warn">${T.notMatched}</span>`}</p></div>
        <canvas class="mini-map" id="miniMap"></canvas>
        ${progHtml}
        <button class="btn primary" id="hStart">${started ? T.continueNav : T.start}</button>
        ${started ? `<button class="btn" id="hRestart">${T.restart}</button>` : ''}
        <button class="btn" id="hChooseDay" aria-expanded="${dayPickerOpen}" aria-controls="dayChoices">${T.chooseDay}</button>
        <button class="btn quiet" id="hOpen">${T.openAnother}</button>
      </div>
      ${voiceRow()}${picker}${foot}</div>`;
    drawMiniMap($('miniMap'));
    $('hStart').onclick = () => startNav({});
    if (started) $('hRestart').onclick = () => { if (confirm(T.restartConfirm)) startNav({ restart: true }); };
    $('hChooseDay').onclick = () => {
      dayPickerOpen = !dayPickerOpen;
      $('dayChoices').hidden = !dayPickerOpen;
      $('hChooseDay').setAttribute('aria-expanded', String(dayPickerOpen));
      if (dayPickerOpen) $('dayChoices').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }
  $('hOpen').onclick = () => $('file').click();
  bindVoiceRow(h);
  h.querySelectorAll('[data-day]').forEach((button) => {
    button.onclick = () => chooseSurveyDay(Number(button.dataset.day));
  });
  fillDayTiles();
}

// The bundled days as tiles: length, and how far this phone got on each
function dayTiles() {
  const meta = store.get(K.dayMeta, {});
  return `<div class="days">${SURVEY_DAYS.map(({ number, name }) => {
    const m = meta[number];
    return `<button class="tile${day && m && m.hash === day.hash ? ' current' : ''}" data-day="${number}">
      <span class="t-name">${name ? esc(name) : T.dayNumber(number)}</span>${tileInfo(m)}</button>`;
  }).join('')}</div>`;
}

function tileInfo(m) {
  if (!m) return '<span class="t-km"></span>';
  const prog = store.get(K.prog(m.hash), null);
  const along = prog && prog.along > 20 ? prog.along : 0;
  const pct = Math.min(100, Math.round(along / m.total * 100));
  return `<span class="t-km">${T.km((m.total / 1000).toFixed(1))}</span>`
    + (along ? `<span class="t-prog"><span class="tb"><i style="width:${pct}%"></i></span><span>${pct}%</span></span>` : '');
}

// Lengths come from the app's own reading of each day (the files also carry other lines), worked out
// once per file version in the background and remembered on this phone
let tilesChecked = false;
async function fillDayTiles() {
  if (tilesChecked) return;
  tilesChecked = true;
  const meta = store.get(K.dayMeta, {});
  for (const { number } of SURVEY_DAYS) {
    try {
      const text = await loadSurveyDay(number);
      const hash = hashText(text);
      if (!meta[number] || meta[number].hash !== hash) {
        const netDoc = await loadNetwork();
        if (!netDoc) { tilesChecked = false; return; }
        meta[number] = { hash, total: Math.round(prepare(text, netDoc).route.total) };
        store.set(K.dayMeta, meta);
      }
      const tile = document.querySelector(`.tile[data-day="${number}"]`);
      if (tile) {
        tile.querySelectorAll('.t-km, .t-prog').forEach((el) => el.remove());
        tile.insertAdjacentHTML('beforeend', tileInfo(meta[number]));
        tile.classList.toggle('current', !!(day && meta[number].hash === day.hash));
      }
    } catch (e) { console.warn('day', number, e); }
    await new Promise((res) => setTimeout(res, 0));
  }
}

function rememberDay(number) {
  const meta = store.get(K.dayMeta, {});
  meta[number] = { hash: day.hash, total: Math.round(day.route.total) };
  store.set(K.dayMeta, meta);
}

async function chooseSurveyDay(number) {
  const name = SURVEY_DAYS.find((entry) => entry.number === number)?.name;
  $('home').innerHTML = loadingHtml(name ? `${T.loading} ${esc(name)}` : T.loadingDay(number));
  try {
    const text = await loadSurveyDay(number);
    await openDay(text, true, name || T.dayNumber(number));      // the day's own name, not the English one in the file
    rememberDay(number);
    dayPickerOpen = false;
    renderHome();
  } catch (e) {
    console.error(e);
    dayPickerOpen = true;
    renderHome(name ? `${T.readError} ${name}` : T.dayLoadError(number));
  }
}

function drawMiniMap(cv) {
  const r = day.route, w = cv.clientWidth || 320, hgt = cv.clientHeight || 190, dpr = window.devicePixelRatio || 1;
  cv.width = w * dpr; cv.height = hgt * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < r.X.length; i++) { x0 = Math.min(x0, r.X[i]); x1 = Math.max(x1, r.X[i]); y0 = Math.min(y0, r.Y[i]); y1 = Math.max(y1, r.Y[i]); }
  const s = Math.min((w - 24) / (x1 - x0 || 1), (hgt - 24) / (y1 - y0 || 1));
  const ox = (w - (x1 - x0) * s) / 2, oy = (hgt - (y1 - y0) * s) / 2;
  const P = (i) => [ox + (r.X[i] - x0) * s, hgt - (oy + (r.Y[i] - y0) * s)];
  // the route from blue (start) to violet (end), as on the driving map
  const A = [0x3d, 0x7b, 0xff], B = [0x8b, 0x5c, 0xf6], parts = 48;
  g.lineWidth = 1.8; g.lineJoin = 'round'; g.lineCap = 'round';
  let i = 0;
  for (let k = 1; k <= parts; k++) {
    const end = r.total * k / parts, t = (k - 0.5) / parts;
    g.strokeStyle = `rgb(${A.map((a, j) => Math.round(a + (B[j] - a) * t)).join(',')})`;
    g.beginPath(); let [x, y] = P(i); g.moveTo(x, y);
    while (i < r.X.length - 1 && r.along[i] < end) { i++; [x, y] = P(i); g.lineTo(x, y); }
    g.stroke();
  }
  const prog = savedProgress();
  if (prog && prog.along > 0) {
    g.strokeStyle = '#6c7285'; g.lineWidth = 3; g.beginPath();
    for (let j = 0; j < r.X.length && r.along[j] <= prog.along; j++) { const [x, y] = P(j); if (j) g.lineTo(x, y); else g.moveTo(x, y); }
    g.stroke();
  }
  const dot = (j, col) => { const [x, y] = P(j); g.fillStyle = col; g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill(); g.strokeStyle = '#10121b'; g.lineWidth = 2; g.stroke(); };
  dot(r.X.length - 1, '#f87171'); dot(0, '#4ade80');
}

$('file').addEventListener('change', async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  $('home').innerHTML = loadingHtml(T.loading);
  try {
    const text = await f.text();
    await openDay(text, true);
    renderHome();
  } catch (e) {
    console.error(e);
    renderHome(e && e.message === 'no-points' ? T.noPoints : T.readError);
  }
});

/* ------------------------------------------------------------------ the map */

function ensureMap() {
  if (map) return mapLoaded;
  const r = day.route, [lat, lon] = day.proj.toLL(r.X[0], r.Y[0]);
  map = new maplibregl.Map({
    container: 'map', style: STYLE, center: [lon, lat], zoom: 16,
    attributionControl: false, maxPitch: 60, fadeDuration: 0, pitchWithRotate: false,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-right');
  map.on('style.load', nightTheme);                  // before anything is drawn: no flash of the day colours
  let done;
  mapLoaded = new Promise((res) => { done = res; });
  let ready = false;
  const finish = () => { if (ready) return; ready = true; addRouteLayers(); mapReady = true; calmMap(); setLabelLang(); applyPadding(); foldCredits(); map.once('idle', foldCredits); done(); };
  map.on('load', finish);
  // No internet and no saved map: draw our own street map so navigation still works
  setTimeout(() => { if (!ready) { map.setStyle(blankStyle()); map.once('styledata', () => { addOwnStreets(); finish(); }); } }, 12000);
  map.on('dragstart', () => setFollow(false));
  map.on('wheel', () => setFollow(false));
  for (const ev of ['zoomstart', 'rotatestart', 'pitchstart']) map.on(ev, (e) => { if (e.originalEvent) setFollow(false); });
  watchHands(map.getCanvasContainer());
  map.on('error', (e) => console.warn('map:', e && e.error && e.error.message));
  const el = document.createElement('div');
  el.className = 'car';
  el.innerHTML = CAR_SVG;
  carMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([lon, lat]).addTo(map);
  window.addEventListener('resize', applyPadding);
  requestAnimationFrame(tick);
  return mapLoaded;
}

function blankStyle() {
  return { version: 8, glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf', sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': NIGHT.bg } }] };
}

// The night map of the design: the OpenFreeMap "liberty" street map recoloured navy, quiet roads, grey names
const NIGHT = { bg: '#10121b', water: '#090b12', park: '#11161e', land: '#12141e', building: '#171a26', buildingLine: '#1d2030',
  motorway: '#3b405a', major: '#363b53', secondary: '#30354a', minor: '#2a2e41', service: '#242838', path: '#1c1f2c',
  casing: '#0d0f17', rail: '#1f2231', label: '#8d93a7', halo: '#0d0f17', waterLabel: '#4c5a82' };
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

// The map credits start folded: a small (i) that opens them
function foldCredits() {
  const a = map && map.getContainer().querySelector('.maplibregl-ctrl-attrib.maplibregl-compact-show');
  if (a) { a.classList.remove('maplibregl-compact-show'); a.setAttribute('open', ''); }
}

function addOwnStreets() {
  const net = day.net;
  if (!net) return;
  const lines = [];
  for (let s = 0; s < net.segCount; s++) {
    const [la1, lo1] = day.proj.toLL(net.X[net.sA[s]], net.Y[net.sA[s]]);
    const [la2, lo2] = day.proj.toLL(net.X[net.sB[s]], net.Y[net.sB[s]]);
    lines.push([[lo1, la1], [lo2, la2]]);
  }
  map.addSource('own-streets', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: lines } } });
  map.addLayer({ id: 'own-streets', type: 'line', source: 'own-streets', paint: { 'line-color': NIGHT.minor, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1, 17, 7] } });
}

function makeIcon(draw, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  draw(g, size);
  return { width: size, height: size, data: g.getImageData(0, 0, size, size).data };
}

function addRouteLayers() {
  map.addImage('chev', makeIcon((g, s) => {
    g.lineWidth = 5; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#ffffff';
    g.beginPath(); g.moveTo(s * 0.32, s * 0.24); g.lineTo(s * 0.62, s * 0.5); g.lineTo(s * 0.32, s * 0.76); g.stroke();
  }, 32), { pixelRatio: 2 });
  map.addImage('head', makeIcon((g, s) => {
    g.beginPath(); g.moveTo(s * 0.5, s * 0.08); g.lineTo(s * 0.9, s * 0.86); g.lineTo(s * 0.1, s * 0.86); g.closePath();
    g.fillStyle = '#f2f3f7'; g.fill(); g.lineWidth = 5; g.strokeStyle = '#0d0f17'; g.lineJoin = 'round'; g.stroke();
  }, 64), { pixelRatio: 2 });
  const empty = { type: 'FeatureCollection', features: [] };
  // line metrics: the next stretch is drawn blue at the car turning violet ahead
  for (const id of ['all', 'missed', 'far', 'near', 'back', 'man', 'manhead']) map.addSource(id, { type: 'geojson', data: empty, lineMetrics: id === 'near' });
  // Above the roads, below the street names (map styles order their layers differently)
  const layers = map.getStyle().layers;
  const firstLabel = (layers.find((l) => l.type === 'symbol' && l['source-layer'] === 'transportation_name')
    || layers.find((l) => l.type === 'symbol' && l['source-layer'] === 'place') || {}).id;
  const line = (id, src, color, width, extra = {}) => map.addLayer({
    id, type: 'line', source: src, layout: { 'line-join': 'round', 'line-cap': 'round', ...(extra.layout || {}) },
    paint: { 'line-color': color, 'line-width': width, ...(extra.paint || {}) },
  }, extra.top ? undefined : firstLabel);
  const zw = (a, b) => ['interpolate', ['exponential', 1.6], ['zoom'], 13, a, 18, b];
  const grad = ['interpolate', ['linear'], ['line-progress'], 0, '#3d7bff', 1, '#8b5cf6'];
  const glow = { 'line-blur': zw(5, 15) };
  line('all', 'all', '#6c7285', zw(1.5, 5), { paint: { 'line-opacity': 0.55 }, layout: { visibility: settings.showAll ? 'visible' : 'none' } });
  line('missed', 'missed', '#f87171', zw(3, 9), { paint: { 'line-dasharray': [1.2, 1.2], 'line-opacity': 0.9 } });
  line('far', 'far', '#5b5fd9', zw(2.5, 9), { paint: { 'line-opacity': 0.6 } });
  line('near-glow', 'near', '#3d7bff', zw(11, 34), { paint: { ...glow, 'line-gradient': grad, 'line-opacity': 0.55 } });
  line('near', 'near', '#3d7bff', zw(4.8, 14.4), { paint: { 'line-gradient': grad } });
  line('back-glow', 'back', BACK.off, zw(11, 34), { paint: { ...glow, 'line-opacity': 0.5 } });
  line('back', 'back', BACK.off, zw(4.8, 14.4));
  backTone = 'off';
  const chev = (id, src) => map.addLayer({
    id, type: 'symbol', source: src,
    layout: { 'symbol-placement': 'line', 'symbol-spacing': 46, 'icon-image': 'chev', 'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.55, 18, 1.1], 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map', 'icon-keep-upright': false },
    paint: { 'icon-opacity': 0.45 },
  }, firstLabel);
  chev('near-chev', 'near'); chev('far-chev', 'far'); chev('back-chev', 'back');
  line('man-case', 'man', '#0d0f17', zw(8, 22), { top: true });
  line('man', 'man', '#f2f3f7', zw(4, 13), { top: true });
  map.addLayer({ id: 'manhead', type: 'symbol', source: 'manhead', layout: { 'icon-image': 'head', 'icon-rotate': ['get', 'b'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.45, 18, 1] } });
}

// The way back: orange after leaving the route, blue on the way to the start or to where the drive stopped
const BACK = { off: '#fb923c', start: '#4f7cff' };
let backTone = null;
function setBackTone(why) {
  const tone = why === 'off' ? 'off' : 'start';
  if (!mapReady || tone === backTone) return;
  backTone = tone;
  map.setPaintProperty('back', 'line-color', BACK[tone]); map.setPaintProperty('back-glow', 'line-color', BACK[tone]);
}

// A driving map: no 3D buildings, no shop and cafe icons; streets, one-way arrows and names stay
function calmMap() {
  for (const l of map.getStyle().layers) {
    if (l.type === 'fill-extrusion' || (l.type === 'symbol' && l['source-layer'] === 'poi')) map.setLayoutProperty(l.id, 'visibility', 'none');
  }
}

// Street and place names in one language only
function setLabelLang() {
  if (!map || !mapReady) return;
  const field = settings.lang === 'ka'
    ? ['coalesce', ['get', 'name:nonlatin'], ['get', 'name'], ['get', 'name:latin']]
    : ['coalesce', ['get', 'name:latin'], ['get', 'name_en'], ['get', 'name']];
  for (const l of map.getStyle().layers) {
    if (l.type !== 'symbol' || !['transportation_name', 'place', 'water_name', 'waterway'].includes(l['source-layer'])) continue;
    const tf = l.layout && l.layout['text-field'];
    if (tf && JSON.stringify(tf).includes('name')) {
      map.setLayoutProperty(l.id, 'text-field', field);
      map.setLayoutProperty(l.id, 'text-transform', 'none');     // capitals would turn Georgian into Mtavruli
    }
  }
}

const lineData = (coords) => (coords && coords.length > 1
  ? { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }
  : { type: 'FeatureCollection', features: [] });
function setLine(id, coords) { if (mapReady) map.getSource(id).setData(lineData(coords)); }
function setHead(coords) {
  if (!mapReady) return;
  if (!coords || coords.length < 2) { map.getSource('manhead').setData({ type: 'FeatureCollection', features: [] }); return; }
  const a = coords[coords.length - 2], b = coords[coords.length - 1];
  const [x1, y1] = day.proj.toXY(a[1], a[0]), [x2, y2] = day.proj.toXY(b[1], b[0]);
  map.getSource('manhead').setData({ type: 'Feature', geometry: { type: 'Point', coordinates: b }, properties: { b: bearing(x1, y1, x2, y2) } });
}

function applyPadding() {
  if (!map) return;
  const land = innerWidth > innerHeight && innerHeight < 560;
  const bottomH = ($('bottom') && !$('navUi').hidden) ? Math.max(20, innerHeight - $('bottom').getBoundingClientRect().top + 16) : 20;
  const pad = land
    ? { top: Math.round(innerHeight * 0.45), bottom: 20, left: Math.min(446, innerWidth * 0.48 + 16), right: 0 }
    : { top: Math.round(innerHeight * 0.44), bottom: bottomH, left: 0, right: 0 };
  map.setPadding(pad);
}

function setFollow(on) {
  follow = on;
  $('btnRecenter').hidden = on || screen !== 'nav';
  clearTimeout(followTimer);
  if (!on) followTimer = setTimeout(() => setFollow(true), 20000);
  else { applyPadding(); glideToCar(); }
}

// Back to the car smoothly (the camera then follows it again)
function glideToCar() {
  if (!map || !view.cur || screen !== 'nav') return;
  const c = view.cur;
  easeUntil = performance.now() + 700;
  map.easeTo({ center: [c.lon, c.lat], bearing: c.brg, zoom: c.zoom, pitch: 50, duration: 650 });
}

// The camera follows the car many times a second, and each move would cancel a finger on the map.
// So a finger on the map stops the following at once; a real move or a pinch keeps it stopped
// (the re-centre button lights up), a plain tap gives it back.
function watchHands(box) {
  let hold = null;
  const begin = (x, y, many) => {
    if (screen !== 'nav') return;
    hold = { x, y, was: follow, moved: !!many };
    follow = false;
    if (many) setFollow(false);
  };
  const move = (x, y, many) => {
    if (!hold || hold.moved) return;
    if (many || Math.hypot(x - hold.x, y - hold.y) > 8) { hold.moved = true; setFollow(false); }
  };
  const end = () => {
    if (!hold) return;
    if (!hold.moved && hold.was) setFollow(true);
    hold = null;
  };
  box.addEventListener('touchstart', (e) => { const t = e.touches[0]; if (!hold) begin(t.clientX, t.clientY, e.touches.length > 1); else if (e.touches.length > 1) move(t.clientX, t.clientY, true); }, { passive: true });
  box.addEventListener('touchmove', (e) => { const t = e.touches[0]; move(t.clientX, t.clientY, e.touches.length > 1); }, { passive: true });
  box.addEventListener('touchend', (e) => { if (!e.touches.length) end(); }, { passive: true });
  box.addEventListener('touchcancel', (e) => { if (!e.touches.length) end(); }, { passive: true });
  box.addEventListener('mousedown', (e) => begin(e.clientX, e.clientY, false));
  window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY, false));
  window.addEventListener('mouseup', end);
}

/* ------------------------------------------------------------------ smooth car + camera */

const view = { from: null, to: null, cur: null, t0: 0, dur: 1000 };
function moveTo(lon, lat, brg, zoom, dur) {
  view.from = view.cur || { lon, lat, brg, zoom };
  view.to = { lon, lat, brg, zoom };
  view.t0 = performance.now(); view.dur = dur;
}
function tick(now) {
  if (view.to && map) {
    const k = clamp((now - view.t0) / view.dur, 0, 1), f = view.from, t = view.to;
    const cur = { lon: f.lon + (t.lon - f.lon) * k, lat: f.lat + (t.lat - f.lat) * k, brg: (f.brg + angleDiff(f.brg, t.brg) * k + 360) % 360, zoom: f.zoom + (t.zoom - f.zoom) * k };
    view.cur = cur;
    carMarker.setLngLat([cur.lon, cur.lat]).setRotation(cur.brg);
    if (follow && screen === 'nav' && now > easeUntil) map.jumpTo({ center: [cur.lon, cur.lat], bearing: cur.brg, zoom: cur.zoom, pitch: 50 });
  }
  requestAnimationFrame(tick);
}

/* ------------------------------------------------------------------ driving */

function startNav({ restart = false, along = null }) {
  unlockSound();
  speak({ type: 'go' }, true);
  if (restart) { store.del(K.prog(day.hash)); store.del(K.trace(day.hash)); trace = []; nav = makeNav(false); }
  else if (!nav) nav = makeNav(true);
  nav.start(along ?? nav.along);
  screen = 'nav'; setPaused(false);
  $('home').hidden = true; $('navUi').hidden = false;
  renderWaiting(T.waitingGps);
  renderStatus(nav.along);
  keepAwake();
  const loaded = ensureMap();                       // creates the map and the car at once
  carMarker.getElement().style.display = '';
  if (!sim) startGps();                             // GPS starts with the tap, not after the map
  loaded.then(() => {
    setFollow(true);
    if (settings.showAll) showWholeDay();
    refreshCoverage(true);
  });
}

function stopNav() {
  stopGps(); stopSim(false); saveProgress(); saveTrace();
  hideGpsHelp(); setPaused(false);
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  renderHome();
}

/* ------------------------------------------------------------------ GPS */

const UA = navigator.userAgent || '';
const IS_IOS = /iP(hone|ad|od)/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
const IS_COMPUTER = !IS_IOS && !/Android|Mobile/i.test(UA);
const GOOD_ACC = 80;                                // metres; rougher fixes are shown but not navigated on
const gps = { started: 0, lastAt: 0, lastGoodAt: 0, acc: null, err: 0, restartAt: 0, timer: null, problem: null };

function startGps() {
  stopGps();
  gpsBlocked = false;
  if (!('geolocation' in navigator)) { showGpsHelp('nofix'); return; }
  if (!gps.started) gps.started = Date.now();
  // No time limit: a phone standing still may not report for a while, and that is not an error
  watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, { enableHighAccuracy: true, maximumAge: 1000 });
  // A quick first answer (often rough) so the screen reacts while the GPS locks on
  navigator.geolocation.getCurrentPosition(onPosition, () => {}, { enableHighAccuracy: false, maximumAge: 30000, timeout: 15000 });
  if (!gps.timer) gps.timer = setInterval(gpsWatchdog, 3000);
}

function stopGps() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  if (gps.timer) clearInterval(gps.timer);
  gps.timer = null;
}

function onGpsError(e) {
  gps.err = e.code;
  if (e.code === 1) { gpsBlocked = true; stopGps(); showGpsHelp('denied'); return; }
  // 2 = no position available, 3 = slow: keep listening, restart the watch now and then
  if (Date.now() - gps.restartAt > 10000) {
    gps.restartAt = Date.now();
    setTimeout(() => { if (screen === 'nav' && !sim && !gpsBlocked) startGps(); }, 2000);
  }
}

function onPosition(p) {
  if (!day || !p || !p.coords) return;
  if (p.timestamp && Date.now() - p.timestamp > 30000) return;      // an old remembered position
  const c = p.coords;
  gps.lastAt = Date.now(); gps.acc = c.accuracy;
  if (c.accuracy <= GOOD_ACC) gps.lastGoodAt = gps.lastAt;
  const [x, y] = day.proj.toXY(c.latitude, c.longitude);
  const speed = Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null;
  const heading = Number.isFinite(c.heading) && c.heading >= 0 && (speed == null || speed > 0.8) ? c.heading : null;
  handleFix({ x, y, t: p.timestamp || Date.now(), acc: c.accuracy, speed, heading, lat: c.latitude, lon: c.longitude });
  gpsWatchdog();
}

// Decide what (if anything) the driver needs to be told about the location
function gpsWatchdog() {
  if (screen !== 'nav' || sim || paused) { hideGpsHelp(); return; }
  const now = Date.now(), running = now - gps.started;
  let problem = null;
  if (gpsBlocked) problem = 'denied';
  else if (!gps.lastAt && running > 20000) problem = 'nofix';
  else if (gps.lastAt && (!gps.lastGoodAt || now - gps.lastGoodAt > 30000) && gps.acc > GOOD_ACC && running > 15000) problem = 'coarse';
  if (problem) showGpsHelp(problem); else hideGpsHelp();
  renderGpsChip();
}

function showGpsHelp(kind) {
  gps.problem = kind;
  const where = IS_COMPUTER ? 'computer' : 'phone';
  $('ghTitle').textContent = kind === 'coarse' ? T.gpsTitle.coarse(T.dist(gps.acc || 0)) : T.gpsTitle[kind];
  $('ghText').textContent = T.gpsHelp[`${kind}_${where}`];
  $('ghRetry').textContent = T.retry;
  $('ghPractice').textContent = T.practice;
  $('gpsHelp').hidden = false;
  if (!nav || nav.mode === 'acquire' || !nav.lastFix) renderWaiting(kind === 'coarse' ? T.waitingPrecise(T.dist(gps.acc || 0)) : T.waitingGps);   // the card below says why
}
function hideGpsHelp() { gps.problem = null; $('gpsHelp').hidden = true; }
$('ghRetry').onclick = () => { hideGpsHelp(); gps.started = Date.now(); gps.lastAt = 0; gps.lastGoodAt = 0; startGps(); };
$('ghPractice').onclick = () => { hideGpsHelp(); startSim(); };

function renderGpsChip() {
  const el = $('gpsChip');
  if (!el) return;
  let cls, about;
  if (sim) { cls = 'sim'; about = T.practice; }
  else if (paused) { cls = 'none'; about = T.gpsOff; }
  else {
    // A phone standing still may report rarely: a reading from the last minute still counts
    const fresh = gps.lastAt && Date.now() - gps.lastAt < 60000;
    const acc = gps.acc;
    cls = !gps.lastAt || !fresh ? 'none' : acc <= 20 ? 'good' : acc <= GOOD_ACC ? 'fair' : 'poor';
    about = !gps.lastAt ? T.gpsNone : !fresh ? T.gpsWait : T.gpsAcc(acc);
  }
  el.className = 'gpschip ' + cls; el.textContent = 'GPS'; el.title = about; el.setAttribute('aria-label', about);
}

function handleFix(fix) {
  if (!nav || screen !== 'nav' || paused) return;
  const snap = nav.update(fix);
  lastSnap = snap; lastRawFix = fix;
  const nowReal = performance.now(), gap = lastFixReal ? nowReal - lastFixReal : 1000;
  lastFixReal = nowReal;
  // the driven track, for sending back to the office
  trace.push([Math.round(fix.t / 1000), +fix.lat.toFixed(6), +fix.lon.toFixed(6), Math.round(fix.acc || 0),
    fix.speed == null ? null : Math.round(fix.speed * 10) / 10, fix.heading == null ? null : Math.round(fix.heading)]);
  if (moving.prev && nav.speed > 1.5) {
    const d = Math.hypot(fix.x - moving.prev.x, fix.y - moving.prev.y), dt = (fix.t - moving.prev.t) / 1000;
    if (dt > 0 && dt < 10 && d < 200) { moving.secs += dt; moving.dist += d; }
  }
  moving.prev = fix;
  for (const e of snap.events) onEvent(e);
  render(snap, fix, clamp(gap, 250, 1200));
  const now = Date.now();
  if (now - covAt > 10000) refreshCoverage();
  if (now - saveAt > 8000) saveProgress();
  if (now - traceAt > 60000) saveTrace();
}

function onEvent(e) {
  if (e.type === 'prompt') { speak(e); return; }
  if (e.type === 'off' || e.type === 'start' || e.type === 'resume') { speak(e); beep(1); }
  if (e.type === 'rejoin') { speak(e); toast(T.rejoined); refreshCoverage(true); }
  if (e.type === 'skip') {
    speak(e);
    toast(T.skipped(T.dist(e.meters)), T.goBack, () => { if (nav.undoSkip()) rerender(nav.snapshot()); });
    refreshCoverage(true);
  }
  if (e.type === 'done') { speak(e); refreshCoverage(true); saveProgress(); setTimeout(openMenu, 1500); }
}

function kindText(m) {
  if (m.kind === 'roundabout') return T.kind.roundabout(m.exit);
  if (m.kind === 'uturn' && m.deadEnd) return T.uturnEnd;
  return T.kind[m.kind] || T.kind.straight;
}
function streetText(m) {
  return settings.lang === 'ka' ? (m.name || m.ref || m.en) : (m.en || m.name || m.ref);
}

// The instruction card: tone, a small tag, arrow, distance, what to do (small) and the street (large)
function setCard({ tone = 'violet', tag = '', icon = '', dist = '', instr = '', street = '' }) {
  $('banner').className = 'banner glass tone-' + tone;
  $('bTag').hidden = !tag; $('bTagText').textContent = tag;
  $('bIcon').innerHTML = icon;
  const k = dist.lastIndexOf(' ');
  $('bDist').innerHTML = dist ? `<span class="num">${esc(dist.slice(0, k))}</span><span class="unit">${esc(dist.slice(k + 1))}</span>` : '';
  $('bInstr').textContent = instr; $('bStreet').textContent = street || '';
}

function renderWaiting(msg) {
  setCard({ tone: 'grey', icon: UI.gps, instr: day ? day.name : '', street: msg });
  $('thenChip').hidden = true; $('btnSkip').disabled = true;
}

// Time left, km left and the time the day ends, from the driving speed so far
function renderStatus(along) {
  const rest = Math.max(0, day.route.total - along);
  const avg = moving.secs > 120 ? moving.dist / moving.secs : 6;
  const mins = Math.round(rest / Math.max(2, avg) / 60);
  $('stTime').textContent = T.timeLeft(Math.floor(mins / 60), mins % 60);
  $('stKm').textContent = T.km((rest / 1000).toFixed(1));
  const end = new Date(Date.now() + mins * 60000);
  $('stEnd').textContent = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
  $('barFill').style.width = (along / day.route.total * 100).toFixed(2) + '%';
}

// Draw again without a new GPS reading (after a setting change, a skip, the coverage refresh)
function rerender(snap) { lastSnap = snap; if (lastRawFix) render(snap, lastRawFix, 300); }

function render(snap, fix, dur) {
  const R = day.route, P = day.proj;
  // The instruction card
  let card = { tone: 'violet' };
  if (snap.mode === 'done') {
    card = { icon: arrowSvg('arrive'), instr: day.name, street: T.done };
  } else if (snap.mode === 'back') {
    const why = snap.back.why;
    card = { tone: why === 'off' ? 'orange' : 'blue', tag: why === 'off' ? T.tagOff : why === 'start' ? T.tagStart : why === 'next' ? T.tagNext : T.tagResume };
    if (snap.next) {
      const m = snap.next.m;
      Object.assign(card, { icon: arrowSvg(m.kind, m.a, m.exit), dist: T.dist(snap.next.dist), instr: kindText(m), street: m.kind === 'rejoin' ? '' : streetText(m) });
    } else {
      const tp = pointAt(R, snap.back.target.along), brg = bearing(fix.x, fix.y, tp[0], tp[1]);
      Object.assign(card, { icon: arrowSvg('direction', angleDiff(nav.heading ?? brg, brg)), dist: T.dist(Math.hypot(tp[0] - fix.x, tp[1] - fix.y)),
        instr: why === 'off' ? T.noWayBack : why === 'start' ? T.toStart : why === 'next' ? T.toNext : T.toResume });
    }
    setBackTone(why);
  } else if (snap.mode === 'acquire') {
    card = { tone: 'grey', icon: UI.gps, instr: day.name, street: fix && fix.acc > GOOD_ACC ? T.waitingPrecise(T.dist(fix.acc)) : T.waitingGps };
  } else if (snap.next) {
    const m = snap.next.m;
    card = { icon: arrowSvg(m.kind, m.a, m.exit), dist: T.dist(snap.next.dist), instr: kindText(m), street: streetText(m) };
  }
  setCard(card);
  const th = snap.then;
  const showThen = th && snap.next && snap.mode !== 'done' && th.gap < 120 && snap.next.dist < 450;
  $('thenChip').hidden = !showThen;
  if (showThen) { $('thenLabel').textContent = T.then; $('thenIcon').innerHTML = arrowSvg(th.m.kind, th.m.a, th.m.exit); }
  $('btnSkip').disabled = !canSkip(snap);

  // Route on the map: only what is ahead
  if (mapReady) {
    if (snap.mode === 'back' && snap.back.path) {
      const p = snap.back.path;
      setLine('back', slice(p, P, snap.back.pos, p.total));
      setLine('near', []);
      setLine('far', slice(R, P, snap.back.target.along, snap.back.target.along + 700));
    } else if (snap.mode === 'back') {
      setLine('back', []); setLine('near', []);
      setLine('far', slice(R, P, snap.back.target.along, snap.back.target.along + 700));
    } else {
      setLine('back', []);
      setLine('near', slice(R, P, snap.along, snap.along + NEAR));
      setLine('far', slice(R, P, snap.along + NEAR - 3, snap.along + AHEAD));
    }
    const n = snap.next;
    if (n && n.dist < 700 && n.m.kind !== 'arrive' && n.m.kind !== 'rejoin') {
      const path = snap.mode === 'back' && snap.back.path ? snap.back.path : R;
      const a1 = n.m.kind === 'roundabout' && n.m.exitAt != null ? path.along[n.m.exitAt] + 14 : n.m.along + 20;
      const coords = slice(path, P, Math.max(0, n.m.along - 22), Math.min(path.total, a1));
      setLine('man', coords); setHead(coords);
    } else { setLine('man', []); setHead(null); }
  }

  // Car and camera: on the line while on the route, the raw fix otherwise
  let cx = fix.x, cy = fix.y, brg = nav.heading ?? (view.cur ? view.cur.brg : 0);
  if (snap.mode === 'route' || snap.mode === 'done') {
    [cx, cy] = pointAt(R, snap.along);
    const a = pointAt(R, Math.max(0, snap.along - 6)), c = pointAt(R, Math.min(R.total, snap.along + 14));
    brg = bearing(a[0], a[1], c[0], c[1]);
  } else if (snap.mode === 'back' && snap.back.path && nav.speed < 2) {
    const p = snap.back.path, a = pointAt(p, snap.back.pos), c = pointAt(p, Math.min(p.total, snap.back.pos + 15));
    brg = bearing(a[0], a[1], c[0], c[1]);
  }
  const [lat, lon] = P.toLL(cx, cy);
  const kmh = (nav.speed || 0) * 3.6;
  let zoom = 17.4 - clamp((kmh - 15) / 45, 0, 1) * 1.1;
  if (snap.next && snap.next.dist < 150) zoom += 0.3;
  moveTo(lon, lat, brg, zoom, dur);
  carMarker.getElement().classList.toggle('off', snap.mode === 'back' && snap.back.why === 'off');

  // Status line and progress
  renderStatus(snap.along);
  renderGpsChip();
}

function refreshCoverage(now = false) {
  if (!nav) return;
  covAt = Date.now();
  cov = nav.coverage();
  const R = day.route, P = day.proj;
  if (mapReady) {
    const lines = cov.missed.map(([a, b]) => slice(R, P, a, b)).filter((l) => l.length > 1);
    map.getSource('missed').setData({ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: lines }, properties: {} });
  }
  $('barMissed').innerHTML = cov.missed.map(([a, b]) => `<i style="left:${(a / R.total * 100).toFixed(2)}%;width:${((b - a) / R.total * 100).toFixed(2)}%"></i>`).join('');
  if (now && lastSnap) rerender(lastSnap);
}

function showWholeDay() {
  if (!mapReady) return;
  map.setLayoutProperty('all', 'visibility', settings.showAll ? 'visible' : 'none');
  if (settings.showAll) map.getSource('all').setData(lineData(slice(day.route, day.proj, 0, day.route.total)));
}

/* ------------------------------------------------------------------ buttons while driving */

$('btnRecenter').onclick = () => setFollow(true);
$('btnRecenter').setAttribute('aria-label', T.recenterLabel);
$('btnRecenter').innerHTML = UI.recentre;
$('btnMenu').innerHTML = UI.menu;
$('btnMenu').setAttribute('aria-label', T.menu);
$('ghIcon').innerHTML = UI.gps;
$('btnSkip').innerHTML = UI.skip;
$('btnSkip').setAttribute('aria-label', T.skipTurn);
function renderMute() {
  $('btnMute').innerHTML = settings.muted ? UI.soundOff : UI.soundOn;
}
$('btnMute').onclick = () => { settings.muted = !settings.muted; saveSettings(); renderMute(); if (!settings.muted) { unlockSound(); beep(1); } };
$('btnMenu').onclick = () => openMenu();
renderMute();

function toast(text, btnText, onBtn) {
  $('toastText').textContent = text;
  const b = $('toastBtn');
  b.hidden = !btnText;
  if (btnText) { b.textContent = btnText; b.onclick = () => { $('toast').hidden = true; onBtn(); }; }
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, btnText ? 15000 : 4000);
}

// Skip the next turn (a closed street): the round button bottom left (bottom right sideways), away from
// menu, sound and pause so it is not hit by accident. It works whenever the car is being led somewhere
// (the route, the way back to it, the way to the start or to where the drive stopped) and a turn is
// ahead; greyed out while waiting for GPS, while paused and on the last stretch
function canSkip(snap) {
  if (paused || !nav || !nav.lastFix || !snap || (snap.mode !== 'route' && snap.mode !== 'back')) return false;
  const i = nav.nextManeuverIndex(nav.along);
  return i < nav.man.length && nav.man[i].kind !== 'arrive';
}
// The stretch goes on the missed list, and the message offers the way back
$('btnSkip').onclick = () => {
  if (!nav || paused || screen !== 'nav' || !canSkip(lastSnap)) return;
  const from = nav.along, before = nav.skips.length, to = nav.jump(1);
  $('btnSkip').disabled = true;           // the next GPS reading brings the new instruction (and the button back)
  speak({ type: 'skip', meters: Math.round(to - from) });
  if (nav.skips.length > before) toast(T.skipped(T.dist(to - from)), T.goBack, () => { if (nav.undoSkip()) rerender(nav.snapshot()); refreshCoverage(); });
  else toast(T.skipped(T.dist(to - from)));
  refreshCoverage();
};

/* ------------------------------------------------------------------ pause (a break: no GPS, no guidance) */

function setPaused(on) {
  paused = on;
  $('pauseCard').hidden = !on;
  if (carMarker) carMarker.getElement().classList.toggle('paused', on);
  // the button under the sound button: pause while driving, violet "continue" while paused
  const b = $('btnPause');
  b.innerHTML = on ? UI.play : UI.pause;
  b.classList.toggle('glass', !on); b.classList.toggle('accent', on);
  b.setAttribute('aria-label', on ? T.resumeNav : T.pauseNav);
}

function pauseNav() {
  if (screen !== 'nav' || paused || !nav) return;
  if (sim) stopSim(false);
  stopGps(); saveProgress(); saveTrace(); hideGpsHelp();
  setPaused(true);
  stopVoice();
  speak({ type: 'paused' });
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  setCard({ tone: 'grey', tag: T.tagPaused, icon: UI.pause, instr: day.name, street: T.pausedTitle });
  $('thenChip').hidden = true; $('btnSkip').disabled = true;
  $('pcText').textContent = T.pausedText; $('pcResume').textContent = T.resumeNav;
  setLine('man', []); setHead(null);
  renderGpsChip();
}

function resumeNav() {
  if (!paused) return;
  setPaused(false);
  nav.start(nav.along);                   // finds the car again; if it is elsewhere, the way back to where it stopped
  gps.started = Date.now(); gps.lastAt = 0; gps.lastGoodAt = 0;
  renderWaiting(T.waitingGps);
  unlockSound(); speak({ type: 'resumed' });
  startGps(); keepAwake(); setFollow(true);
  renderGpsChip();
}
$('pcResume').onclick = () => resumeNav();
$('btnPause').onclick = () => { if (paused) resumeNav(); else pauseNav(); };
setPaused(false);

// The menu sheet slides up from the bottom; it closes with a tap outside it, its Close button,
// or a pull down (from the handle, or anywhere while the list is scrolled to its top)
let sheetTimer = null;
function sheetMotion(transform, opacity, ms) {
  const sh = $('sheet'), back = $('sheetBack');
  sh.style.transition = ms ? `transform ${ms}ms cubic-bezier(.2, .8, .2, 1)` : 'none';
  back.style.transition = ms ? `opacity ${ms}ms` : 'none';
  sh.style.transform = transform; back.style.opacity = opacity;
}
function showSheet() {
  const sh = $('sheet');
  clearTimeout(sheetTimer);
  if (sh.hidden) {
    sh.hidden = false; $('sheetBack').hidden = false;
    sheetMotion('translateY(100%)', '0', 0);
    sh.getBoundingClientRect();                       // start from below the screen
  }
  sheetMotion('', '', 240);
}
function closeMenu() {
  const sh = $('sheet');
  if (sh.hidden) return;
  sheetMotion('translateY(100%)', '0', 200);
  clearTimeout(sheetTimer);
  sheetTimer = setTimeout(() => { sh.hidden = true; $('sheetBack').hidden = true; sheetMotion('', '', 0); }, 200);
}
$('sheetBack').onclick = () => closeMenu();

(function pullDownToClose() {
  const sh = $('sheet');
  let y0 = 0, t0 = 0, dy = 0, may = false, pulling = false;
  sh.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { may = false; return; }
    y0 = e.touches[0].clientY; t0 = performance.now(); dy = 0; pulling = false;
    may = sh.scrollTop <= 0 || !!e.target.closest('.grab-zone');
  }, { passive: true });
  sh.addEventListener('touchmove', (e) => {
    if (!may || e.touches.length !== 1) return;
    const d = e.touches[0].clientY - y0;
    if (!pulling) {
      if (d < -6) { may = false; return; }             // pushing up: the list scrolls as usual
      if (d < 6) return;
      pulling = true;
    }
    e.preventDefault();                                // the sheet follows the finger instead of the list scrolling
    dy = Math.max(0, d);
    sheetMotion(`translateY(${dy}px)`, String(Math.max(0, 1 - dy / sh.offsetHeight)), 0);
  }, { passive: false });
  const end = () => {
    if (!pulling) return;
    pulling = false;
    const fast = dy / Math.max(1, performance.now() - t0) > 0.6;
    if (dy > Math.min(140, sh.offsetHeight * 0.25) || (fast && dy > 30)) closeMenu();
    else sheetMotion('', '', 200);                     // a small pull springs back
  };
  sh.addEventListener('touchend', end);
  sh.addEventListener('touchcancel', end);
})();

function openMenu() {
  if (!nav) return;
  const c = nav.coverage();
  cov = c;
  const sh = $('sheet');
  sh.innerHTML = `<div class="grab-zone"><div class="grab"></div></div>
    ${paused ? `<button class="item accent" id="mResume">${UI.play}<span>${T.resumeNav}</span></button>` : `<button class="item accent" id="mPause">${UI.pause}<span>${T.pauseNav}</span></button>`}
    <button class="item" id="mHere">${UI.gps}<span>${T.fromHere}</span></button>
    <button class="item" id="mBack">${T.backTurn}</button>
    <h3>${T.missedTitle}</h3>
    ${c.missed.length ? `<ul class="missed-list">${c.missed.map(([a, b], i) => `<li><b>${i + 1}.</b> ${T.missedAt((a / 1000).toFixed(2), T.dist(b - a))}</li>`).join('')}</ul>` : `<div class="note">${T.missedNone}</div>`}
    <button class="item" id="mShareMissed" ${c.missed.length ? '' : 'disabled'}>${T.shareMissed}</button>
    <button class="item" id="mShareTrack">${T.shareTrack}</button>
    <button class="item" id="mAll">${settings.showAll ? '✓ ' : ''}${T.showAll}</button>
    ${voiceRow()}
    <button class="item" id="mSim">${sim ? T.stopSim : T.simulate}</button>
    <button class="item danger" id="mEnd">${T.endNav}</button>
    <button class="item" id="mClose">${T.close}</button>`;
  showSheet();
  if (paused) $('mResume').onclick = () => { closeMenu(); resumeNav(); };
  else $('mPause').onclick = () => { closeMenu(); pauseNav(); };
  $('mBack').onclick = () => { nav.jump(-1); closeMenu(); refreshCoverage(true); };
  $('mHere').onclick = () => { const moved = nav.continueHere(); closeMenu(); if (moved != null && moved > 10) toast(T.jumped(T.dist(moved))); refreshCoverage(true); };
  $('mShareMissed').onclick = () => shareGpx(missedGpx(c.missed), 'missed');
  $('mShareTrack').onclick = () => shareGpx(trackGpx(), 'driven');
  $('mAll').onclick = () => { settings.showAll = !settings.showAll; saveSettings(); showWholeDay(); openMenu(); };
  bindVoiceRow(sh);
  $('mSim').onclick = () => { closeMenu(); if (paused) setPaused(false); if (sim) stopSim(true); else startSim(); };
  $('mEnd').onclick = () => { closeMenu(); stopNav(); };
  $('mClose').onclick = () => closeMenu();
}

/* ------------------------------------------------------------------ files to send back */

const gpxHead = (name) => `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Survey Navigator" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${esc(name)}</name><time>${new Date().toISOString()}</time></metadata>\n`;

function missedGpx(missed) {
  const R = day.route, P = day.proj;
  let out = gpxHead(`${day.name}: missed stretches`);
  missed.forEach(([a, b], i) => {
    out += `<trk><name>Missed ${i + 1}: ${(a / 1000).toFixed(2)} km, ${Math.round(b - a)} m</name><trkseg>\n`;
    for (const [lo, la] of slice(R, P, a, b)) out += `<trkpt lat="${la.toFixed(6)}" lon="${lo.toFixed(6)}"/>\n`;
    out += '</trkseg></trk>\n';
  });
  return out + '</gpx>\n';
}

function trackGpx() {
  let out = gpxHead(`${day.name}: driven track`) + '<trk><name>Driven</name><trkseg>\n';
  for (const [t, la, lo, acc, sp, hd] of trace) {
    out += `<trkpt lat="${la}" lon="${lo}"><time>${new Date(t * 1000).toISOString()}</time><hdop>${(acc / 5).toFixed(1)}</hdop>${sp != null ? `<extensions><speed>${sp}</speed>${hd != null ? `<course>${hd}</course>` : ''}</extensions>` : ''}</trkpt>\n`;
  }
  return out + '</trkseg></trk>\n</gpx>\n';
}

async function shareGpx(text, kind) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const base = (day.name || 'route').replace(/[^\w\-]+/g, '_').slice(0, 40);
  const name = `${base}_${kind}_${stamp}.gpx`;
  const file = new File([text], name, { type: 'application/gpx+xml' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

/* ------------------------------------------------------------------ saving progress on this phone */

function saveProgress() { if (nav && day && !sim) { saveAt = Date.now(); store.set(K.prog(day.hash), { ...nav.serialize(), at: saveAt }); } }
function saveTrace() {
  if (!day || sim) return;
  traceAt = Date.now();
  if (!store.set(K.trace(day.hash), trace)) store.set(K.trace(day.hash), trace.slice(-20000));
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { saveProgress(); saveTrace(); }
  else if (screen === 'nav') keepAwake();
});
window.addEventListener('pagehide', () => { saveProgress(); saveTrace(); });

async function keepAwake() {
  try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); } } catch { /* not allowed now */ }
}

/* ------------------------------------------------------------------ sound */

let audioCtx = null, voiceList = [];
function loadVoices() { try { voiceList = speechSynthesis.getVoices() || []; } catch { voiceList = []; } }
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
// A better-sounding English voice if the phone has one downloaded; otherwise the phone's usual English voice
// (not just the first in the list: on an iPhone that can be one of the joke voices)
function pickVoice(code) {
  const list = voiceList.filter((v) => (v.lang || '').toLowerCase().startsWith(code));
  return list.find((v) => /enhanced|premium/i.test(v.name)) || list.find((v) => v.default) || null;
}

function unlockSound() {
  try {
    // iPhone: speak even with the ring / silent switch on silent (iOS 16.4+)
    if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback';
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    loadVoice();
  } catch { /* no audio */ }
}

// The recorded Georgian voice (js/voice.js): the clips are read once, then joined for each instruction
const voiceBuf = new Map();
let voiceLoading = null, voiceNodes = [], voiceLog = [];
function loadVoice() {
  if (voiceLoading || !audioCtx) return voiceLoading;
  voiceLoading = Promise.all(VOICE_CLIPS.map(async (name) => {
    try {
      const r = await fetch(VOICE_DIR + name + '.m4a');
      if (r.ok) voiceBuf.set(name, await audioCtx.decodeAudioData(await r.arrayBuffer()));
    } catch (e) { console.warn('voice clip', name, e); }
  }));
  return voiceLoading;
}
function stopVoice() {
  for (const s of voiceNodes) { try { s.stop(); } catch { /* already over */ } }
  voiceNodes = [];
  try { speechSynthesis.cancel(); } catch { /* no speech */ }
}
function playClips(names) {
  if (!audioCtx || !names || !names.every((n) => voiceBuf.has(n))) return false;
  stopVoice();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  let t = audioCtx.currentTime + 0.05;
  names.forEach((n, k) => {
    const s = audioCtx.createBufferSource();
    s.buffer = voiceBuf.get(n); s.connect(audioCtx.destination); s.start(t);
    voiceNodes.push(s);
    t += s.buffer.duration + gapAfter(names, k);
  });
  voiceLog.push(names.join('+'));
  return true;
}
// Say what goes with a navigator event. Georgian: the recorded clips (a line whose clip is missing is said
// by the English voice). English: the phone's English voice, started at once so that a tap can wake it.
async function speak(e, force = false) {
  if (!force && settings.muted) return;
  if (settings.voiceLang === 'ka' || !('speechSynthesis' in window)) {
    const names = clipsFor(e);
    if (names && audioCtx) {
      if (!names.every((n) => voiceBuf.has(n))) await Promise.race([loadVoice(), new Promise((r) => setTimeout(r, 2000))]);
      if (playClips(names)) return;
    }
  }
  say(speech('en', e), force);
}

function beep(n = 1) {
  if (settings.muted || !audioCtx) return;
  const t0 = audioCtx.currentTime;
  for (let i = 0; i < n; i++) {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = i ? 660 : 880; o.type = 'sine';
    g.gain.setValueAtTime(0.0001, t0 + i * 0.22); g.gain.exponentialRampToValueAtTime(0.5, t0 + i * 0.22 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.22 + 0.18);
    o.connect(g).connect(audioCtx.destination); o.start(t0 + i * 0.22); o.stop(t0 + i * 0.22 + 0.2);
  }
}

function say(text, force = false) {
  if (!text || !('speechSynthesis' in window)) return;
  if (!force && settings.muted) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice('en');
    if (v) u.voice = v;
    u.lang = v ? v.lang : 'en-US';
    u.rate = 1.0;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch { /* speech not available */ }
}

// The voice choice, on the start screen and in the menu: Georgian (recorded) or English (the phone's voice).
// A tap plays a sample in the chosen voice: a turn on the start screen; while driving, only how things stand
// (so that nobody takes a sample turn for a real one).
const VOICE_SAMPLE = { type: 'prompt', stage: 'far', dist: 300, m: { kind: 'right' } };
function voiceRow() {
  return `<div class="voicerow"><span class="vr-label">${UI.soundOn}<span>${T.voiceLang}</span></span>
    <div class="seg2" role="radiogroup" aria-label="${T.voiceLang}">${['ka', 'en'].map((v) => `<button role="radio" data-voice="${v}"
      aria-checked="${settings.voiceLang === v}" class="${settings.voiceLang === v ? 'on' : ''}">${T.voiceNames[v]}</button>`).join('')}</div></div>`;
}
function bindVoiceRow(root) {
  const buttons = [...root.querySelectorAll('[data-voice]')];
  for (const b of buttons) {
    b.onclick = () => {
      settings.voiceLang = b.dataset.voice; saveSettings();
      for (const x of buttons) { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); }
      unlockSound(); stopVoice();
      speak(screen === 'nav' ? { type: paused ? 'paused' : 'resumed' } : VOICE_SAMPLE, true);
    };
  }
}

/* ------------------------------------------------------------------ practice drive */

function startSim() {
  stopGps();
  // A practice drive never touches the real day: keep the real progress aside and put it back afterwards
  saveProgress(); saveTrace();
  simBackup = { prog: nav.serialize(), trace };
  trace = [];
  sim = new SimCar(nav, { speed: 9, noise: 3, seed: (Date.now() & 0xffff) + 1, startAlong: nav.along });
  simClock = 0; simFed = -1;
  hideGpsHelp();
  $('simBar').hidden = false;
  renderSimBar(); applyPadding();
  simTimer = setInterval(() => {
    const dt = 0.1 * simMult;
    const fx = sim.step(dt);
    simClock += dt;
    if (simClock - simFed >= 1) {
      simFed = simClock;
      const [lat, lon] = day.proj.toLL(fx.x, fx.y);
      handleFix({ ...fx, lat, lon, t: Math.round(simClock * 1000) + 1e12 });
    }
  }, 100);
}
function stopSim(restartGps = false) {
  if (simTimer) clearInterval(simTimer);
  const wasSim = !!sim;
  simTimer = null; sim = null;
  $('simBar').hidden = true;
  applyPadding();
  if (wasSim && simBackup) {
    nav = makeNav(false); nav.restore(simBackup.prog); trace = simBackup.trace; simBackup = null;
    if (screen === 'nav') nav.start(nav.along);
    refreshCoverage(false);
  }
  if (restartGps && screen === 'nav') startGps();
}
function renderSimBar() {
  const bar = $('simBar');
  bar.querySelectorAll('[data-mult]').forEach((b) => { b.classList.toggle('on', +b.dataset.mult === simMult); b.onclick = () => { simMult = +b.dataset.mult; renderSimBar(); }; });
  $('simTitle').textContent = T.practice;
  $('simMiss').textContent = T.simMissShort; $('simMiss').onclick = () => sim && sim.planMiss();
  $('simStop').textContent = T.simStopShort; $('simStop').onclick = () => stopSim(true);
}

/* ------------------------------------------------------------------ offline: keep this route's map */

async function warmOffline(bbox) {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;
  try {
    const tj = await (await fetch(TILEJSON)).json();
    const tpl = tj.tiles[0], maxz = Math.min(14, tj.maxzoom || 14);
    const urls = [];
    const pad = 0.012;
    const [w, s, e, n] = [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad];
    const tx = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
    const ty = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
    for (let z = 10; z <= maxz; z++) {
      for (let x = tx(w, z); x <= tx(e, z); x++) for (let y = ty(n, z); y <= ty(s, z); y++) urls.push(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y));
    }
    urls.push(STYLE);
    for (const font of ['Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic']) {
      for (const range of ['0-255', '256-511', '4096-4351', '8192-8447']) urls.push(`https://tiles.openfreemap.org/fonts/${encodeURIComponent(font)}/${range}.pbf`);
    }
    let i = 0;
    const worker = async () => { while (i < urls.length) { const u = urls[i++]; try { await fetch(u, { mode: 'cors' }); } catch { /* offline */ } } };
    await Promise.all([worker(), worker(), worker(), worker()]);
  } catch { /* offline now; the map still works where it has been seen */ }
}

/* ------------------------------------------------------------------ start up */

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
}

(async function boot() {
  document.documentElement.lang = settings.lang;
  const saved = store.get(K.route, null);
  if (saved && saved.text) {
    $('home').innerHTML = `<div class="wrap"><div class="card"><span class="spinner"></span>${T.loadingMap}</div></div>`;
    try { await openDay(saved.text, false, saved.name); } catch (e) { console.error(e); day = null; }
  } else loadNetwork();
  renderHome();
})();

// For the automated checks: drive the app without touching it
window.__sn = {
  openText: async (text) => { await openDay(text, true); renderHome(); },
  start: (opts = {}) => startNav(opts),
  sim: (mult = 4) => { simMult = mult; startSim(); },
  miss: () => sim && sim.planMiss(),
  stopSim: () => stopSim(false),
  menu: () => openMenu(),
  pause: () => pauseNav(),
  resume: () => resumeNav(),
  get follow() { return follow; }, get paused() { return paused; },
  get voice() { return { lang: settings.voiceLang, loaded: voiceBuf.size, log: voiceLog.slice() }; },
  snap: () => lastSnap && { mode: lastSnap.mode, along: lastSnap.along, next: lastSnap.next && { kind: lastSnap.next.m.kind, dist: lastSnap.next.dist }, back: !!lastSnap.back },
  coverage: () => nav && nav.coverage(),
  feed: (fix) => handleFix(fix),
  get nav() { return nav; }, get map() { return map; }, get day() { return day; },
};
