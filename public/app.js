/* Tableau de bord : carte + recherche par numero. */
'use strict';

/* ------------------------------------------------------------- cle d'acces */

const params = new URLSearchParams(location.search);
let KEY = params.get('k') || localStorage.getItem('gps_key') || '';
if (params.get('k')) {
  localStorage.setItem('gps_key', KEY);
  history.replaceState(null, '', location.pathname);   // on retire la cle de la barre d'adresse
}
if (!KEY) {
  KEY = (prompt("Clé d'accès (voir config.json / la console du serveur) :") || '').trim();
  if (KEY) localStorage.setItem('gps_key', KEY);
}

/* ------------------------------------------------------------------ carte */

const map = L.map('map', { zoomControl: true, attributionControl: true })
  .setView([14.6937, -17.4441], 12);              // Dakar par defaut

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap'
}).addTo(map);

const pinIcon = L.divIcon({ className: '', html: '<div class="pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });

let marker = null;      // position actuelle
let halo = null;        // cercle de precision
let trail = null;       // polyligne du trajet
let followMap = true;   // recentrer automatiquement

/* ------------------------------------------------------------------ outils */

const $ = (id) => document.getElementById(id);
const err = $('err');

function setError(msg) { err.textContent = msg || ''; }

function age(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'il y a ' + s + ' s';
  const m = Math.round(s / 60);
  if (m < 60) return 'il y a ' + m + ' min';
  const h = Math.floor(m / 60);
  if (h < 24) return 'il y a ' + h + ' h ' + (m % 60) + ' min';
  return 'il y a ' + Math.floor(h / 24) + ' j';
}

function stateOf(ts) {
  const d = Date.now() - ts;
  if (d < 90 * 1000) return { cls: 'live', txt: 'En direct' };
  if (d < 30 * 60 * 1000) return { cls: 'old', txt: 'Position récente' };
  return { cls: 'off', txt: 'Hors ligne' };
}

function stateColor(ts) {
  const c = stateOf(ts).cls;
  return c === 'live' ? 'var(--ok)' : c === 'old' ? 'var(--warn)' : 'var(--muted)';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch('/api' + path + sep + 'k=' + encodeURIComponent(KEY));
  const data = await r.json().catch(() => ({ error: 'réponse illisible' }));
  if (!r.ok) throw new Error(data.error || ('erreur ' + r.status));
  return data;
}

/* ---------------------------------------------------------------- affichage */

let current = null;      // appareil affiche
let stream = null;       // EventSource
let tick = null;         // rafraichissement de l'age

function drawPosition(last, history) {
  const ll = [last.lat, last.lon];

  if (!marker) {
    marker = L.marker(ll, { icon: pinIcon }).addTo(map);
    halo = L.circle(ll, { radius: last.acc || 0, color: '#2f81f7', weight: 1, fillOpacity: 0.12 }).addTo(map);
  } else {
    marker.setLatLng(ll);
    halo.setLatLng(ll).setRadius(last.acc || 0);
  }

  if (history && history.length > 1) {
    const pts = history.map((p) => [p.lat, p.lon]);
    if (trail) trail.setLatLngs(pts);
    else trail = L.polyline(pts, { color: '#2f81f7', weight: 3, opacity: 0.45 }).addTo(map);
  }

  if (followMap) {
    const z = Math.max(map.getZoom(), 16);
    map.setView(ll, z, { animate: true });
  }
}

function render() {
  if (!current || !current.last) return;
  const d = current;
  const l = d.last;
  const st = stateOf(l.ts);
  const when = new Date(l.ts).toLocaleString('fr-FR');

  $('result').innerHTML = `
    <div class="card">
      <div class="top">
        <span class="num">${esc(d.phone)}</span>
        ${d.label ? `<span class="label">${esc(d.label)}</span>` : ''}
      </div>
      <span class="state ${st.cls}"><i></i>${st.txt} · ${age(l.ts)}</span>
      <dl class="grid">
        <div><dt>Latitude</dt><dd>${l.lat.toFixed(6)}</dd></div>
        <div><dt>Longitude</dt><dd>${l.lon.toFixed(6)}</dd></div>
        <div><dt>Précision</dt><dd>${l.acc != null ? '± ' + l.acc + ' m' : '—'}</dd></div>
        <div><dt>Batterie</dt><dd>${l.bat != null ? l.bat + ' %' + (l.chg ? ' ⚡' : '') : '—'}</dd></div>
        <div><dt>Vitesse</dt><dd>${l.spd != null ? Math.round(l.spd * 3.6) + ' km/h' : '—'}</dd></div>
        <div><dt>Altitude</dt><dd>${l.alt != null ? l.alt + ' m' : '—'}</dd></div>
        <div style="grid-column:1/-1"><dt>Horodatage</dt><dd>${esc(when)}</dd></div>
      </dl>
      <div class="actions">
        <a class="btn" target="_blank" rel="noopener"
           href="https://www.google.com/maps/dir/?api=1&destination=${l.lat},${l.lon}">Itinéraire</a>
        <a class="btn" target="_blank" rel="noopener"
           href="https://www.google.com/maps/search/?api=1&query=${l.lat},${l.lon}">Vue satellite</a>
        <button class="ghost" id="recenter">Centrer</button>
      </div>
    </div>`;

  $('recenter').onclick = () => { followMap = true; map.setView([l.lat, l.lon], 17); };
}

/* ----------------------------------------------------------------- recherche */

async function locate(phone) {
  setError('');
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 6) return setError('Numéro trop court.');

  $('go').disabled = true;
  try {
    const d = await api('/device?history=1&phone=' + encodeURIComponent(digits));
    if (!d.last) throw new Error("Cet appareil est enregistré mais n'a envoyé aucune position.");

    current = d;
    followMap = true;
    render();
    drawPosition(d.last, d.history);
    listen(digits);

    clearInterval(tick);
    tick = setInterval(render, 10000);              // l'age se rafraichit tout seul
  } catch (e) {
    setError(e.message);
    $('result').innerHTML = '';
  } finally {
    $('go').disabled = false;
  }
}

function listen(digits) {
  if (stream) stream.close();
  stream = new EventSource('/api/events?phone=' + encodeURIComponent(digits) + '&k=' + encodeURIComponent(KEY));
  stream.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.type !== 'position' || !current) return;
    current.last = msg.last;
    if (!current.history) current.history = [];
    current.history.push(msg.last);
    render();
    drawPosition(msg.last, current.history);
  };
}

/* -------------------------------------------------------- liste des appareils */

async function refreshList() {
  try {
    const { devices } = await api('/devices');
    const wrap = $('list-wrap');
    if (!devices.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    $('list').innerHTML = devices.map((d) => `
      <button class="device" data-phone="${esc(d.phone)}">
        <span class="d-dot" style="background:${d.last ? stateColor(d.last.ts) : 'var(--muted)'}"></span>
        <span class="d-num">${esc(d.phone)}${d.label ? ' · ' + esc(d.label) : ''}</span>
        <span class="d-age">${d.last ? age(d.last.ts) : 'jamais vu'}</span>
      </button>`).join('');

    $('list').querySelectorAll('.device').forEach((b) => {
      b.onclick = () => { $('q').value = b.dataset.phone; locate(b.dataset.phone); };
    });
  } catch (e) {
    setError(e.message === 'cle invalide'
      ? "Clé d'accès invalide — rechargez la page avec le bon lien."
      : e.message);
  }
}

/* --------------------------------------------------------------- initialisation */

$('go').onclick = () => locate($('q').value);
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') locate($('q').value); });

// Dès que l'utilisateur déplace la carte à la main, on arrête de recentrer.
map.on('dragstart', () => { followMap = false; });

const trackerUrl = location.origin + '/tracker?k=' + encodeURIComponent(KEY);
$('tracker-link').href = trackerUrl;
$('copy-link').onclick = async () => {
  try {
    await navigator.clipboard.writeText(trackerUrl);
    $('copy-link').textContent = 'Lien copié !';
    setTimeout(() => ($('copy-link').textContent = 'Copier le lien'), 1800);
  } catch (_) {
    prompt('Copiez ce lien :', trackerUrl);
  }
};
$('setup').hidden = false;

refreshList();
setInterval(refreshList, 20000);
