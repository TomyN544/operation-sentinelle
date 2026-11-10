// Serveur Opération Sentinelle : sert le jeu et relie les joueurs (LAN ou internet).
// Aucune dépendance : seulement Node.js. Lancer avec : node serveur.js
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const PORT = Number(process.env.PORT) || 8080;
const GAME = path.join(__dirname, "..", "operation-sentinelle.html");
const SHIM = path.join(__dirname, "client.js");
const DATA = path.join(__dirname, "donnees.json");

// ---------- Données sauvegardées (réglages admin, classement, noms) ----------
let data = { admin: "", docs: {}, names: {}, tokens: {} };
try { data = Object.assign(data, JSON.parse(fs.readFileSync(DATA, "utf8"))); } catch { /* premier lancement */ }
if (!data.tokens || typeof data.tokens !== "object") data.tokens = {};
if (!data.admin) data.admin = crypto.randomBytes(4).toString("hex");
// En ligne, l'admin choisit son code dans les réglages de l'hébergeur (variable ADMIN_CODE).
if (process.env.ADMIN_CODE) data.admin = String(process.env.ADMIN_CODE).trim();

// ---------- Sauvegarde en ligne (facultative) ----------
// Les hébergeurs gratuits effacent le disque à chaque redémarrage. Si UPSTASH_REDIS_REST_URL et
// UPSTASH_REDIS_REST_TOKEN sont définis, les données sont aussi gardées dans une base Upstash gratuite.
const KV_URL = String(process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const KV_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || "");
const KV_KEY = "operation-sentinelle";
let kvReady = false, kvTimer = null;
async function kv(cmd) {
  const r = await fetch(KV_URL, { method: "POST", headers: { Authorization: "Bearer " + KV_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error("Upstash a répondu " + r.status);
  return (await r.json()).result;
}
async function loadRemote() {
  if (!KV_URL || !KV_TOKEN) { console.log("  Sauvegarde en ligne : désactivée (données gardées sur le disque seulement)."); return; }
  try {
    const raw = await kv(["GET", KV_KEY]);
    if (raw) {
      const saved = JSON.parse(raw);
      for (const k of ["docs", "names", "tokens"]) if (saved[k] && typeof saved[k] === "object") data[k] = saved[k];
      if (saved.admin && !process.env.ADMIN_CODE) data.admin = saved.admin;
    }
    kvReady = true;
    console.log("  Sauvegarde en ligne : active (Upstash).");
  } catch (e) {
    // On ne sauvegarde pas en ligne si la lecture a échoué, pour ne pas écraser les vraies données.
    console.error("  Sauvegarde en ligne indisponible :", e.message);
  }
}
async function saveRemote() {
  if (!kvReady) return;
  try { await kv(["SET", KV_KEY, JSON.stringify(data)]); } catch (e) { console.error("Sauvegarde en ligne échouée :", e.message); }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DATA, JSON.stringify(data, null, 1), () => {}), 300);
  clearTimeout(kvTimer);
  kvTimer = setTimeout(saveRemote, 3000);
}
save();
// À l'arrêt du serveur (mise en veille, redéploiement), on enregistre une dernière fois.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { clearTimeout(kvTimer); saveRemote().finally(() => process.exit(0)); });

// ---------- Page du jeu ----------
const HEAD = '<!doctype html><html lang="fr"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  "<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}" +
  "body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>";
function page() {
  let game = fs.readFileSync(GAME, "utf8");
  game = game.replace(
    "Seules les personnes avec qui tu as partagé ce jeu (niveau « Peut utiliser » ou plus) peuvent rejoindre.",
    "Tous les joueurs connectés à ce serveur peuvent rejoindre avec le code."
  );
  return HEAD + "<script>" + fs.readFileSync(SHIM, "utf8") + "</script>" + game + "</body></html>";
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://local");
  if (url.pathname === "/" || url.pathname === "/index.html") {
    try {
      const body = page();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Fichier du jeu introuvable : " + GAME);
    }
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Introuvable");
});

// ---------- WebSocket minimal ----------
const conns = new Set();
server.on("upgrade", (req, sock) => {
  const url = new URL(req.url, "http://local");
  const key = req.headers["sec-websocket-key"];
  if (url.pathname !== "/ws" || !key) { sock.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  // Admin : la personne qui joue sur le PC du serveur, ou qui a le lien admin.
  const ra = req.socket.remoteAddress || "";
  const forwarded = req.headers["x-forwarded-for"] || req.headers["cf-connecting-ip"];
  const local = /^(::1|127\.|::ffff:127\.)/.test(ra) && !forwarded;
  // Protection : 64 connexions au total, 6 par adresse (plusieurs onglets ou appareils d'un même foyer).
  const ip = String(req.headers["cf-connecting-ip"] || String(forwarded || "").split(",")[0] || ra).trim();
  let sameIp = 0;
  for (const o of conns) if (o.ip === ip) sameIp++;
  if (conns.size >= 64 || (!local && sameIp >= 6)) { sock.destroy(); return; }
  const c = {
    ip, local, rateT: 0, rateN: 0,
    sock, buf: Buffer.alloc(0), frag: [], alive: true,
    peer: crypto.randomBytes(8).toString("hex"), uid: null,
    admin: local || url.searchParams.get("admin") === data.admin,
    rooms: new Map(), subs: new Map(),
  };
  conns.add(c);
  sock.setNoDelay(true);
  sock.on("data", (chunk) => onData(c, chunk));
  sock.on("close", () => drop(c));
  sock.on("error", () => drop(c));
});
function frame(payload, op) {
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}
function send(c, obj) { if (!c.sock.destroyed) c.sock.write(frame(Buffer.from(JSON.stringify(obj)), 1)); }
function onData(c, chunk) {
  c.buf = Buffer.concat([c.buf, chunk]);
  while (c.buf.length >= 2) {
    const b0 = c.buf[0], b1 = c.buf[1], op = b0 & 15, fin = b0 & 128, masked = b1 & 128;
    let len = b1 & 127, off = 2;
    if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
    if (len > 1 << 20) { c.sock.destroy(); return; }
    const start = off + (masked ? 4 : 0), end = start + len;
    if (c.buf.length < end) return;
    let payload = Buffer.from(c.buf.subarray(start, end));
    if (masked) { const m = c.buf.subarray(off, off + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
    c.buf = c.buf.subarray(end);
    if (op === 8) { c.sock.end(frame(Buffer.alloc(0), 8)); return; }
    if (op === 9) { c.sock.write(frame(payload, 10)); continue; }
    if (op === 10) { c.alive = true; continue; }
    if (op === 1 || op === 0) {
      c.frag.push(payload);
      if (!fin) continue;
      const text = Buffer.concat(c.frag).toString("utf8");
      c.frag = [];
      let msg;
      try { msg = JSON.parse(text); } catch { continue; }
      // Anti-spam : au-delà de 150 messages par seconde ils sont ignorés, au-delà de 600 la connexion est coupée.
      const now = Date.now();
      if (now - c.rateT > 1000) { c.rateT = now; c.rateN = 0; }
      if (++c.rateN > 600) { c.sock.destroy(); return; }
      if (c.rateN > 150) continue;
      if (msg && typeof msg === "object") { try { handle(c, msg); } catch (e) { console.error("Erreur :", e.message); } }
    }
  }
}
setInterval(() => {
  for (const c of conns) {
    if (!c.alive) { c.sock.destroy(); continue; }
    c.alive = false;
    if (!c.sock.destroyed) c.sock.write(frame(Buffer.alloc(0), 9));
  }
}, 20000);

// ---------- Salons multijoueur ----------
const rooms = new Map();
const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const TOPIC_RE = /^[a-z][a-z0-9_.-]{0,47}$/;
const PATH_RE = /^[A-Za-z0-9_.~:@+-]{1,200}(\/[A-Za-z0-9_.~:@+-]{1,200}){1,15}$/;
const cleanId = (s) => (typeof s === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(s) ? s : "u" + crypto.randomBytes(8).toString("hex"));
const peerInfo = (c, name) => ({ peer: c.peer, by: c.uid, presence: c.rooms.get(name) || {} });
function toRoom(name, obj, except) {
  const r = rooms.get(name);
  if (r) for (const o of r.values()) if (o !== except) send(o, obj);
}
function reply(c, m, err, extra) { if (m.rid) send(c, { t: "res", rid: m.rid, err: err || null, ...(extra || {}) }); }
function setName(uid, nick) {
  if (!uid || typeof nick !== "string") return;
  const clean = nick.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 16);
  if (!clean || data.names[uid] === clean) return;
  data.names[uid] = clean;
  save();
  for (const o of conns) send(o, { t: "names", names: { [uid]: clean } });
}
function leaveRoom(c, name) {
  const r = rooms.get(name);
  if (!r || !c.rooms.has(name)) return;
  r.delete(c.peer);
  c.rooms.delete(name);
  toRoom(name, { t: "pleft", room: name, peer: c.peer });
  if (!r.size) rooms.delete(name);
}
function drop(c) {
  if (!conns.has(c)) return;
  conns.delete(c);
  for (const name of [...c.rooms.keys()]) leaveRoom(c, name);
}

// ---------- Base de données ----------
const parentOf = (p) => p.split("/").slice(0, -1).join("/");
function canWrite(c, p) {
  if (c.admin) return true;
  const seg = p.split("/");
  return seg.length === 2 && (seg[0] === "scores" || seg[0] === "friends") && seg[1] === c.uid;
}
function sendSnap(c, id) {
  const s = c.subs.get(id);
  if (!s) return;
  if (s.kind === "doc") send(c, { t: "snap", id, doc: data.docs[s.path] || null });
  else send(c, { t: "snap", id, docs: Object.entries(data.docs).filter(([k]) => parentOf(k) === s.path).map(([k, v]) => ({ id: k.split("/").pop(), data: v })) });
}
function notify(p) {
  for (const c of conns) for (const [id, s] of c.subs) if ((s.kind === "doc" && s.path === p) || (s.kind === "col" && s.path === parentOf(p))) sendSnap(c, id);
}

// ---------- Liens à partager ----------
const TUNNEL_LOG = path.join(__dirname, "tunnel.log");
function publicUrl() {
  const env = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  if (env) return String(env).replace(/\/+$/, "");
  try {
    const all = fs.readFileSync(TUNNEL_LOG, "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
    return all ? all[all.length - 1] : null;
  } catch { return null; }
}
function lanIps() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === "IPv4" && !i.internal) ips.push(i.address);
  return ips;
}
const lanUrl = () => `http://${lanIps()[0] || "localhost"}:${PORT}`;
const links = () => ({ code: data.admin, public: publicUrl(), lan: lanUrl() });

// ---------- Messages ----------
function handle(c, m) {
  switch (m.t) {
    case "links":
      if (!c.admin) return reply(c, m, "invalid_argument");
      reply(c, m, null, links());
      break;
    case "newcode":
      if (!c.admin) return reply(c, m, "invalid_argument");
      data.admin = crypto.randomBytes(4).toString("hex");
      data.tokens = {};
      for (const o of conns) if (o.admin && !o.local && o !== c) { o.admin = false; send(o, { t: "admin", admin: false }); }
      save();
      console.log("\n  Nouveau code admin : les anciens liens admin ne marchent plus.\n");
      reply(c, m, null, links());
      break;
    case "setadmin": {
      // Un admin nomme (ou retire) un autre joueur connecté. Le jeton personnel garde ses droits s'il recharge la page.
      if (!c.admin) return reply(c, m, "invalid_argument");
      const target = [...conns].find((o) => o.peer === m.peer);
      if (!target || !target.uid) return reply(c, m, "invalid_argument");
      if (m.on) {
        const token = crypto.randomBytes(12).toString("hex");
        data.tokens[token] = target.uid;
        target.admin = true;
        send(target, { t: "admin", admin: true, token });
      } else {
        if (target.local) return reply(c, m, "invalid_argument");
        for (const k in data.tokens) if (data.tokens[k] === target.uid) delete data.tokens[k];
        target.admin = false;
        send(target, { t: "admin", admin: false });
      }
      save();
      reply(c, m);
      break;
    }
    case "hello":
      c.uid = cleanId(m.uid);
      if (typeof m.token === "string" && m.token && data.tokens[m.token] === c.uid) c.admin = true;
      if (m.nick) setName(c.uid, m.nick);
      send(c, { t: "hello", peer: c.peer, admin: c.admin, names: data.names });
      break;
    case "join": {
      const name = String(m.room || "");
      if (!ROOM_RE.test(name)) return reply(c, m, "invalid_argument");
      let r = rooms.get(name);
      if (!r) rooms.set(name, (r = new Map()));
      if (!c.rooms.has(name)) {
        c.rooms.set(name, {});
        r.set(c.peer, c);
        toRoom(name, { t: "pjoin", room: name, ...peerInfo(c, name) }, c);
      }
      reply(c, m, null, { peers: [...r.values()].map((o) => peerInfo(o, name)) });
      break;
    }
    case "leave":
      leaveRoom(c, String(m.room || ""));
      reply(c, m);
      break;
    case "pres": {
      const name = String(m.room || "");
      if (!c.rooms.has(name) || !m.patch || typeof m.patch !== "object") return;
      const p = { ...c.rooms.get(name) };
      for (const k in m.patch) { if (m.patch[k] === null) delete p[k]; else p[k] = m.patch[k]; }
      if (JSON.stringify(p).length > 4096) return;
      c.rooms.set(name, p);
      if (typeof m.patch.nick === "string") setName(c.uid, m.patch.nick);
      toRoom(name, { t: "pupd", room: name, ...peerInfo(c, name) }, c);
      break;
    }
    case "emit": {
      const name = String(m.room || ""), topic = String(m.topic || "");
      if (!c.rooms.has(name) || !TOPIC_RE.test(topic)) return;
      if (topic === "adm" && !c.admin) return;
      if (JSON.stringify(m.data === undefined ? null : m.data).length > 8192) return;
      toRoom(name, { t: "msg", room: name, topic, data: m.data, peer: c.peer, by: c.uid });
      break;
    }
    case "get":
      reply(c, m, null, { doc: data.docs[String(m.path)] || null });
      break;
    case "set":
    case "del": {
      const p = String(m.path || "");
      if (!PATH_RE.test(p) || p.split("/").length % 2 || !canWrite(c, p)) return reply(c, m, "invalid_argument");
      if (m.t === "set") {
        if (!m.data || typeof m.data !== "object" || Array.isArray(m.data) || JSON.stringify(m.data).length > 65536) return reply(c, m, "invalid_argument");
        data.docs[p] = m.data;
      } else delete data.docs[p];
      save();
      reply(c, m);
      notify(p);
      break;
    }
    case "sub":
      if (c.subs.size > 60) return;
      c.subs.set(m.id, { kind: m.kind === "col" ? "col" : "doc", path: String(m.path || "") });
      sendSnap(c, m.id);
      break;
    case "unsub":
      c.subs.delete(m.id);
      break;
  }
}

// ---------- Démarrage ----------
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.error(`\nLe port ${PORT} est déjà utilisé. Ferme l'autre fenêtre du serveur, ou lance avec un autre port.\n`);
  else console.error(e);
  process.exit(1);
});
loadRemote().then(() => server.listen(PORT, () => {
  const ips = lanIps();
  console.log("\n  OPÉRATION SENTINELLE — serveur lancé\n");
  const pub = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  if (pub) console.log(`  Adresse publique :           ${pub}`);
  console.log(`  Toi (sur ce PC) :            http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  Tes amis sur le même Wi-Fi : http://${ip}:${PORT}`);
  console.log(`\n  Pour nommer un ami admin : dans le jeu, ouvre le panel admin,`);
  console.log(`  section « Ajouter un admin », et copie le lien admin.`);
  console.log("\n  Laisse cette fenêtre ouverte pendant la partie. Ctrl+C pour arrêter.\n");
}));
