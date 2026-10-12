#!/usr/bin/env node
/**
 * Localisateur GPS - serveur (aucune dependance npm)
 *
 * Deux faces :
 *   /          -> tableau de bord : carte + recherche par numero
 *   /tracker   -> page a ouvrir SUR le telephone : il envoie sa position GPS
 *
 * Les positions sont stockees dans data/devices.json. La derniere position
 * connue reste donc disponible meme si le telephone s'eteint ou se verrouille.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'devices.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');

const PORT = Number(process.env.PORT) || 3000;
const MAX_HISTORY = 800;          // points de trajet conserves par appareil
const MAX_BODY = 32 * 1024;       // 32 Ko max par requete

/* ------------------------------------------------------------------ config */

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    const cfg = { key: crypto.randomBytes(9).toString('base64url') };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    console.log("\n  config.json cree. Cle d'acces : " + cfg.key + "\n");
    return cfg;
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

const CONFIG = loadConfig();
// La cle peut etre surchargee par une variable d'environnement (utile en ligne).
const ACCESS_KEY = process.env.ACCESS_KEY || CONFIG.key;

function keyOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(ACCESS_KEY));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ----------------------------------------------------------------- stockage */

let db = {};
try {
  if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch (err) {
  console.error('devices.json illisible, on repart a vide :', err.message);
}

let saveTimer = null;
function save() {
  if (saveTimer) return;                      // ecriture groupee : 1x/2s max
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFile(DB_FILE + '.tmp', JSON.stringify(db), (err) => {
      if (err) return console.error('ecriture:', err.message);
      fs.rename(DB_FILE + '.tmp', DB_FILE, (e) => e && console.error(e.message));
    });
  }, 2000);
}

/**
 * Cle d'un appareil : les 9 derniers chiffres du numero.
 * Ainsi "+221 77 123 45 67", "00221771234567" et "771234567" donnent la meme cle.
 */
function normPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length > 9 ? digits.slice(-9) : digits;
}

/* ------------------------------------------------- temps reel (SSE) */

const clients = new Map();   // cle appareil -> Set(res)

function broadcast(key, payload) {
  const set = clients.get(key);
  if (!set || !set.size) return;
  const frame = 'data: ' + JSON.stringify(payload) + '\n\n';
  for (const res of set) {
    try { res.write(frame); } catch (_) { set.delete(res); }
  }
}

/* ------------------------------------------------------------------ helpers */

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('corps trop volumineux')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('JSON invalide')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function serveStatic(res, rel) {
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('interdit');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('introuvable');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

function publicInfo(entry) {
  return {
    phone: entry.phone,
    label: entry.label || '',
    last: entry.last || null,
    points: (entry.history || []).length
  };
}

/* -------------------------------------------------------------------- routes */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;

  // --- pages ---
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
  if (req.method === 'GET' && (p === '/tracker' || p === '/t')) return serveStatic(res, 'tracker.html');

  // --- API ---
  if (p.startsWith('/api/')) {

    // Le telephone envoie sa position.
    if (p === '/api/ping' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }

      if (!keyOk(body.key)) return sendJSON(res, 401, { error: 'cle invalide' });

      const key = normPhone(body.phone);
      if (key.length < 6) return sendJSON(res, 400, { error: 'numero invalide' });

      const lat = Number(body.lat), lon = Number(body.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
          Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return sendJSON(res, 400, { error: 'coordonnees invalides' });
      }

      const point = {
        lat: +lat.toFixed(6),
        lon: +lon.toFixed(6),
        acc: Number.isFinite(Number(body.acc)) ? Math.round(Number(body.acc)) : null,
        alt: Number.isFinite(Number(body.alt)) ? Math.round(Number(body.alt)) : null,
        spd: Number.isFinite(Number(body.spd)) ? +Number(body.spd).toFixed(1) : null,
        hdg: Number.isFinite(Number(body.hdg)) ? Math.round(Number(body.hdg)) : null,
        bat: Number.isFinite(Number(body.bat)) ? Math.round(Number(body.bat)) : null,
        chg: body.chg === true ? true : (body.chg === false ? false : null),
        ts: Date.now()
      };

      const entry = db[key] || (db[key] = { phone: '', label: '', history: [] });
      entry.phone = String(body.phone || entry.phone).slice(0, 32);
      if (body.label) entry.label = String(body.label).slice(0, 48);
      entry.last = point;
      entry.history.push(point);
      if (entry.history.length > MAX_HISTORY) {
        entry.history.splice(0, entry.history.length - MAX_HISTORY);
      }
      save();

      broadcast(key, { type: 'position', phone: entry.phone, label: entry.label, last: point });
      return sendJSON(res, 200, { ok: true, saved: point.ts });
    }

    // Tout le reste exige la cle en query string.
    if (!keyOk(url.searchParams.get('k'))) return sendJSON(res, 401, { error: 'cle invalide' });

    // Recherche par numero.
    if (p === '/api/device' && req.method === 'GET') {
      const key = normPhone(url.searchParams.get('phone'));
      const entry = db[key];
      if (!entry) return sendJSON(res, 404, { error: 'aucun appareil enregistre pour ce numero' });
      const out = publicInfo(entry);
      if (url.searchParams.get('history') === '1') out.history = entry.history || [];
      return sendJSON(res, 200, out);
    }

    // Liste de mes appareils.
    if (p === '/api/devices' && req.method === 'GET') {
      const list = Object.keys(db)
        .map((k) => publicInfo(db[k]))
        .sort((a, b) => ((b.last && b.last.ts) || 0) - ((a.last && a.last.ts) || 0));
      return sendJSON(res, 200, { devices: list });
    }

    // Suppression d'un appareil.
    if (p === '/api/device' && req.method === 'DELETE') {
      const key = normPhone(url.searchParams.get('phone'));
      if (!db[key]) return sendJSON(res, 404, { error: 'inconnu' });
      delete db[key];
      save();
      return sendJSON(res, 200, { ok: true });
    }

    // Flux temps reel pour un numero.
    if (p === '/api/events' && req.method === 'GET') {
      const key = normPhone(url.searchParams.get('phone'));
      if (key.length < 6) return sendJSON(res, 400, { error: 'numero invalide' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write('retry: 3000\n\n');

      if (!clients.has(key)) clients.set(key, new Set());
      clients.get(key).add(res);

      const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
      req.on('close', () => {
        clearInterval(beat);
        const set = clients.get(key);
        if (set) { set.delete(res); if (!set.size) clients.delete(key); }
      });
      return;
    }

    return sendJSON(res, 404, { error: 'route inconnue' });
  }

  // --- fichiers statiques ---
  if (req.method === 'GET') return serveStatic(res, p.replace(/^\/+/, ''));

  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('methode non autorisee');
});

server.listen(PORT, () => {
  console.log('\n  Localisateur GPS demarre');
  console.log('  Tableau de bord : http://localhost:' + PORT + '/?k=' + ACCESS_KEY);
  console.log('  Page telephone  : http://localhost:' + PORT + '/tracker?k=' + ACCESS_KEY);
  console.log("\n  Cle d'acces : " + ACCESS_KEY + '  (gardez-la privee)\n');
});
