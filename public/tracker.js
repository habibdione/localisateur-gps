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

/* ------------------------------------------------------------- sonnerie */

let audioCtx = null;
let alarmNodes = null;
let alarmTimer = null;
let vibrateTimer = null;
let lastRing = 0;

function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (_) { /* ignore */ }
}

function stopAlarmSound() {
  if (alarmNodes) {
    try { alarmNodes.osc.stop(); } catch (_) {}
    try { alarmNodes.osc.disconnect(); alarmNodes.gain.disconnect(); } catch (_) {}
    alarmNodes = null;
  }
}

function playAlarm() {
  unlockAudio();
  if (!audioCtx) return;
  stopAlarmSound();

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'square';
  osc.connect(gain);
  gain.connect(audioCtx.destination);

  // Sirene : la frequence alterne (haut/bas) pendant 18 s.
  const t0 = audioCtx.currentTime;
  for (let i = 0; i < 36; i++) {
    const t = t0 + i * 0.5;
    osc.frequency.setValueAtTime(i % 2 ? 1100 : 700, t);
    gain.gain.setValueAtTime(0.7, t);
  }
  osc.start();
  alarmNodes = { osc, gain };

  if (navigator.vibrate) {
    try { navigator.vibrate([400, 200, 400, 200, 400]); } catch (_) {}
    vibrateTimer = setInterval(() => { try { navigator.vibrate([400, 200, 400]); } catch (_) {} }, 1600);
  }

  $('ring-banner').hidden = false;
  clearTimeout(alarmTimer);
  alarmTimer = setTimeout(stopAlarm, 18000);   // s'arrete toute seule
  log('SONNERIE declenchee a distance');
}

function stopAlarm() {
  stopAlarmSound();
  clearTimeout(alarmTimer);
  clearInterval(vibrateTimer);
  if (navigator.vibrate) { try { navigator.vibrate(0); } catch (_) {} }
  $('ring-banner').hidden = true;
}

function maybeRing(ts) {
  if (ts && ts > lastRing) { lastRing = ts; playAlarm(); }
}

/* Flux temps reel : recoit l'ordre de sonnerie envoye du tableau de bord. */
let cmdStream = null;
function openCommandStream(digits) {
  if (cmdStream) cmdStream.close();
  try {
    cmdStream = new EventSource('/api/events?phone=' + encodeURIComponent(digits) + '&k=' + encodeURIComponent(KEY));
    cmdStream.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.type === 'ring') maybeRing(m.ts || Date.now());
    };
  } catch (_) { /* SSE indisponible : le ping recuperera la sonnerie */ }
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
    if (data.ring) maybeRing(data.ring);            // sonnerie demandee ?
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

  unlockAudio();              // autorise le son (on est dans un tap utilisateur)
  openCommandStream(digits);  // ecoute les ordres de sonnerie
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
  if (cmdStream) { cmdStream.close(); cmdStream = null; }
  stopAlarm();
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  $('box').hidden = true;
  $('toggle').textContent = 'Démarrer le suivi';
  $('toggle').classList.remove('stop');
  $('phone').disabled = $('label').disabled = false;
  log('suivi arrêté');
}

$('toggle').onclick = () => (watchId === null ? start() : stop());
$('stop-ring').onclick = stopAlarm;

// Reprise automatique si le suivi etait actif avant la fermeture de la page.
if (localStorage.getItem('gps_auto') === '1' && $('phone').value) start();
$('toggle').addEventListener('click', () => {
  localStorage.setItem('gps_auto', watchId === null ? '0' : '1');
});
