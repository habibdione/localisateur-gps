/* Page ouverte SUR le telephone : lit le GPS et l'envoie au serveur. */
'use strict';

const $ = (id) => document.getElementById(id);

/* -------------------------------------------------------------- cle + memoire */

const params = new URLSearchParams(location.search);
let KEY = params.get('k') || localStorage.getItem('gps_key') || '';
if (KEY) localStorage.setItem('gps_key', KEY);

$('phone').value = localStorage.getItem('gps_phone') || '';
$('label').value = localStorage.getItem('gps_label') || '';

function log(msg) {
  const t = new Date().toLocaleTimeString('fr-FR');
  $('log').textContent = t + '  ' + msg + '\n' + $('log').textContent.slice(0, 2000);
}

/* ------------------------------------------------------------------- batterie */

let battery = null;
if (navigator.getBattery) {
  navigator.getBattery().then((b) => { battery = b; }).catch(() => {});
}

/* --------------------------------------------------------------- ecran allume */

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (_) { /* refuse ou non supporte : sans gravite */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && watchId !== null && !wakeLock) keepAwake();
});

/* ------------------------------------------------------------------ envoi */

let lastSent = 0;
const MIN_INTERVAL = 5000;        // on n'envoie pas plus d'une position / 5 s

async function send(pos) {
  const c = pos.coords;
  const body = {
    key: KEY,
    phone: $('phone').value,
    label: $('label').value,
    lat: c.latitude,
    lon: c.longitude,
    acc: c.accuracy,
    alt: c.altitude,
    spd: c.speed,
    hdg: c.heading,
    bat: battery ? Math.round(battery.level * 100) : null,
    chg: battery ? battery.charging : null
  };

  try {
    const r = await fetch('/api/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('erreur ' + r.status));
    log('position envoyée (±' + Math.round(c.accuracy) + ' m)');
    $('err').textContent = '';
  } catch (e) {
    log('échec envoi : ' + e.message);
    $('err').textContent = 'Envoi impossible : ' + e.message;
  }
}

function onPosition(pos) {
  const c = pos.coords;
  $('coords').textContent = c.latitude.toFixed(6) + ', ' + c.longitude.toFixed(6);
  $('meta').textContent = 'Précision ± ' + Math.round(c.accuracy) + ' m'
    + (battery ? ' · batterie ' + Math.round(battery.level * 100) + ' %' : '');

  const now = Date.now();
  if (now - lastSent < MIN_INTERVAL) return;
  lastSent = now;
  send(pos);
}

function onError(e) {
  const msgs = {
    1: "Permission refusée. Autorisez la localisation pour ce site dans les réglages du navigateur.",
    2: 'Position indisponible (GPS coupé ou aucun signal).',
    3: 'Délai dépassé, nouvelle tentative…'
  };
  $('err').textContent = msgs[e.code] || e.message;
  log('erreur GPS ' + e.code);
}

/* -------------------------------------------------------------- marche/arret */

let watchId = null;
let heartbeat = null;

function start() {
  const digits = $('phone').value.replace(/\D/g, '');
  if (digits.length < 6) { $('err').textContent = 'Saisissez un numéro valide.'; return; }
  if (!KEY) { $('err').textContent = "Clé d'accès manquante : ouvrez le lien fourni par le tableau de bord."; return; }
  if (!navigator.geolocation) { $('err').textContent = "Ce navigateur ne gère pas la géolocalisation."; return; }
  if (!window.isSecureContext) {
    $('err').textContent = "La géolocalisation exige HTTPS (ou localhost). Voir le README pour la mise en ligne.";
    return;
  }

  localStorage.setItem('gps_phone', $('phone').value);
  localStorage.setItem('gps_label', $('label').value);

  watchId = navigator.geolocation.watchPosition(onPosition, onError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 20000
  });

  // Filet de securite : meme immobile, on signale qu'on est vivant chaque minute.
  heartbeat = setInterval(() => {
    navigator.geolocation.getCurrentPosition((p) => { lastSent = 0; onPosition(p); }, () => {}, {
      enableHighAccuracy: true, maximumAge: 30000, timeout: 20000
    });
  }, 60000);

  keepAwake();
  $('box').hidden = false;
  $('toggle').textContent = 'Arrêter le suivi';
  $('toggle').classList.add('stop');
  $('phone').disabled = $('label').disabled = true;
  log('suivi démarré');
}

function stop() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  clearInterval(heartbeat);
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  $('box').hidden = true;
  $('toggle').textContent = 'Démarrer le suivi';
  $('toggle').classList.remove('stop');
  $('phone').disabled = $('label').disabled = false;
  log('suivi arrêté');
}

$('toggle').onclick = () => (watchId === null ? start() : stop());

// Reprise automatique si le suivi etait actif avant la fermeture de la page.
if (localStorage.getItem('gps_auto') === '1' && $('phone').value) start();
$('toggle').addEventListener('click', () => {
  localStorage.setItem('gps_auto', watchId === null ? '0' : '1');
});
