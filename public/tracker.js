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
let ringing = false;

/**
 * Construit une sirene (2 s, tons alternes) en WAV encode en data-URI.
 * Un element <audio> debloque par un geste joue mieux sur iPhone que l'API Web Audio.
 */
function buildSirenWavUri() {
  const sr = 8000, dur = 2, n = sr * dur;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const freq = (Math.floor(t * 2) % 2 === 0) ? 800 : 1200;   // sirene
    const s = Math.sin(2 * Math.PI * freq * t) * 0.7;
    v.setInt16(44 + i * 2, s * 32767, true);
  }
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
}

try { $('alarm-audio').src = buildSirenWavUri(); } catch (_) {}

function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (_) { /* ignore */ }
  // Debloque l'element <audio> dans ce geste (joue en silencieux puis met en pause).
  try {
    const a = $('alarm-audio');
    a.muted = true;
    const p = a.play();
    if (p && p.then) p.then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
    else { a.pause(); a.currentTime = 0; a.muted = false; }
  } catch (_) {}
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
  ringing = true;

  // 1) Element <audio> (meilleur sur iPhone, et joue meme si Web Audio est bride).
  try {
    const a = $('alarm-audio');
    a.muted = false;
    a.currentTime = 0;
    const p = a.play();
    if (p && p.catch) p.catch(() => {});
  } catch (_) {}

  // 2) Sirene Web Audio (forte sur Android/PC).
  if (audioCtx) {
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
  }

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
  ringing = false;
  stopAlarmSound();
  try { const a = $('alarm-audio'); a.pause(); a.currentTime = 0; } catch (_) {}
  clearTimeout(alarmTimer);
  clearInterval(vibrateTimer);
  if (navigator.vibrate) { try { navigator.vibrate(0); } catch (_) {} }
  $('ring-banner').hidden = true;
}

// Si la page revient au premier plan pendant une sonnerie, on relance le son
// (iOS/Android suspendent l'audio en arriere-plan).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ringing) {
    try { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); } catch (_) {}
    try { const a = $('alarm-audio'); a.muted = false; const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
  }
});

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
    // (l'eventuel avertissement de precision est gere par onPosition)
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

  // Precision mediocre = localisation approximative (reseau/WiFi) : la position
  // ne suivra pas bien les deplacements. On previent l'utilisateur.
  if (c.accuracy > 200) {
    $('err').textContent = '⚠️ Position approximative (± ' + Math.round(c.accuracy)
      + ' m). Activez la localisation PRÉCISE / le GPS de ce téléphone pour un suivi exact.';
  } else {
    $('err').textContent = '';
  }

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

function normId(raw) {
  const s = String(raw || '').trim();
  const d = s.replace(/\D/g, '');
  if (d.length >= 6) return d.length > 9 ? d.slice(-9) : d;
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
}

function start() {
  const digits = normId($('phone').value);
  if (digits.length < 2) { $('err').textContent = "Saisissez un numéro ou un nom d'appareil."; return; }
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
