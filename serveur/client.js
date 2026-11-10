// Remplace les services de claude.ai par ce serveur : salons multijoueur, sauvegarde et joueurs.
// Le jeu appelle window.claude.use("room" | "db" | "user") comme sur claude.ai.
(function () {
  "use strict";
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* indisponible */ } },
  };
  let uid = LS.get("os-uid");
  if (!uid || !/^[A-Za-z0-9_-]{4,64}$/.test(uid)) { uid = "u" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); LS.set("os-uid", uid); }
  const nickNow = () => { try { return JSON.parse(LS.get("os-nick") || '""') || ""; } catch { return ""; } };
  const adminCode = new URLSearchParams(location.search).get("admin") || "";

  let ws = null, open = false, myPeer = null, admin = false, helloDone = false, rid = 0, subId = 0;
  const names = {}, pending = new Map(), subs = new Map(), rooms = new Map(), connHandlers = new Set();
  let helloResolve;
  const helloP = new Promise((r) => (helloResolve = r));

  const wsSend = (o) => { if (ws && open) ws.send(JSON.stringify(o)); };
  function request(o) {
    return new Promise((res, rej) => {
      if (!open) { rej({ code: "unavailable", message: "Serveur injoignable" }); return; }
      const id = ++rid;
      pending.set(id, { res, rej });
      wsSend({ ...o, rid: id });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej({ code: "unavailable", message: "Pas de réponse du serveur" }); } }, 10000);
    });
  }
  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    try { ws = new WebSocket(`${proto}//${location.host}/ws${adminCode ? "?admin=" + encodeURIComponent(adminCode) : ""}`); }
    catch { helloResolve(false); return; }
    ws.onopen = () => { open = true; wsSend({ t: "hello", uid, nick: nickNow(), token: LS.get("os-admtok") || "" }); };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } onMsg(m); };
    ws.onclose = () => {
      const was = open;
      open = false;
      for (const h of connHandlers) { try { h(false); } catch { /* ignoré */ } }
      if (!was && !helloDone) helloResolve(false);
      setTimeout(connect, 2000);
    };
  }
  function onMsg(m) {
    if (m.t === "hello") {
      myPeer = m.peer; admin = !!m.admin; Object.assign(names, m.names || {});
      if (!helloDone) { joinHall(); helloDone = true; helloResolve(true); }
      else {
        for (const r of rooms.values()) r._rejoin();
        for (const [id, s] of subs) wsSend({ t: "sub", id, kind: s.kind, path: s.path });
      }
      for (const h of connHandlers) { try { h(true); } catch { /* ignoré */ } }
      return;
    }
    if (m.t === "res") {
      const p = pending.get(m.rid);
      if (p) { pending.delete(m.rid); if (m.err) p.rej({ code: m.err, message: m.err }); else p.res(m); }
      return;
    }
    if (m.t === "names") { Object.assign(names, m.names || {}); return; }
    if (m.t === "admin") {
      admin = !!m.admin;
      LS.set("os-admtok", admin && m.token ? m.token : admin ? LS.get("os-admtok") || "" : "");
      try { window.dispatchEvent(new CustomEvent("os-admin", { detail: { admin } })); } catch { /* hors navigateur */ }
      return;
    }
    if (m.t === "snap") { const s = subs.get(m.id); if (s) s.deliver(m); return; }
    if (m.room) { const r = rooms.get(m.room); if (r) r._event(m); }
  }

  // ---------- Salons ----------
  function makeRoom(name) {
    const peers = new Map(), peerH = new Set(), topicH = new Map();
    let myPres = {}, snapshot = Object.freeze([]), alive = true;
    const wrap = (p) => ({ peer: p.peer, by: p.by, isMe: p.peer === myPeer, sameTab: p.peer === myPeer, kind: "viewer", guest: false, presence: p.presence, updatedAt: p.updatedAt });
    const rebuild = () => { snapshot = Object.freeze([...peers.values()].map(wrap)); };
    const fire = (joined, left, updated) => {
      rebuild();
      const ch = { peers: snapshot, joined: joined.map(wrap), left: left.map(wrap), updated: updated.map(wrap) };
      for (const h of [...peerH]) { try { h(ch); } catch (e) { console.error(e); } }
    };
    const init = (list) => {
      peers.clear();
      for (const p of list) peers.set(p.peer, { peer: p.peer, by: p.by, presence: p.presence || {}, updatedAt: Date.now() });
      peers.set(myPeer, { peer: myPeer, by: uid, presence: { ...myPres }, updatedAt: Date.now() });
      rebuild();
    };
    const room = {
      name,
      emit(topic, data) {
        if (!alive) return Promise.reject({ code: "invalid_argument", message: "Salon quitté" });
        wsSend({ t: "emit", room: name, topic, data });
        return Promise.resolve();
      },
      on(topic, h) {
        if (!topicH.has(topic)) topicH.set(topic, new Set());
        topicH.get(topic).add(h);
        return () => topicH.get(topic).delete(h);
      },
      presence(patch) {
        for (const k in patch) { if (patch[k] === null) delete myPres[k]; else myPres[k] = patch[k]; }
        const me = peers.get(myPeer);
        if (me) { me.presence = { ...myPres }; me.updatedAt = Date.now(); fire([], [], [me]); }
        wsSend({ t: "pres", room: name, patch });
        return Promise.resolve();
      },
      peers() { return snapshot; },
      onPeers(h) {
        peerH.add(h);
        Promise.resolve().then(() => { if (peerH.has(h)) h({ peers: snapshot, joined: snapshot, left: [], updated: [] }); });
        return () => peerH.delete(h);
      },
      connected() { return open; },
      onConnection(h) { connHandlers.add(h); Promise.resolve().then(() => h(open)); return () => connHandlers.delete(h); },
      leave() {
        alive = false; rooms.delete(name); peerH.clear(); topicH.clear();
        wsSend({ t: "leave", room: name });
        return Promise.resolve();
      },
      _init: init,
      _rejoin() {
        request({ t: "join", room: name }).then((res) => {
          init(res.peers || []);
          if (Object.keys(myPres).length) wsSend({ t: "pres", room: name, patch: myPres });
          fire(snapshot.slice(), [], []);
        }, () => {});
      },
      _event(m) {
        if (m.t === "msg") {
          const hs = topicH.get(m.topic);
          if (!hs) return;
          const msg = { topic: m.topic, data: m.data, peer: m.peer, by: m.by, isMe: m.peer === myPeer, sameTab: m.peer === myPeer, kind: "viewer", guest: false };
          for (const h of [...hs]) { try { h(msg); } catch (e) { console.error(e); } }
        } else if (m.t === "pjoin") {
          const p = { peer: m.peer, by: m.by, presence: m.presence || {}, updatedAt: Date.now() };
          peers.set(m.peer, p); fire([p], [], []);
        } else if (m.t === "pupd") {
          if (m.peer === myPeer) return;
          const p = peers.get(m.peer) || { peer: m.peer, by: m.by };
          p.presence = m.presence || {}; p.updatedAt = Date.now();
          peers.set(m.peer, p); fire([], [], [p]);
        } else if (m.t === "pleft") {
          const p = peers.get(m.peer);
          if (p) { peers.delete(m.peer); fire([], [p], []); }
        }
      },
    };
    return room;
  }
  // Salon commun à tous les joueurs du serveur : amis en ligne et invitations.
  let hall = null;
  function joinHall() {
    if (!hall) { hall = makeRoom("hall"); rooms.set("hall", hall); }
    hall._rejoin();
  }
  const lobby = {
    join(name) {
      if (!/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(name) || name === "hall") return Promise.reject({ code: "invalid_argument", message: "Nom de salon invalide" });
      if (rooms.has(name)) return Promise.resolve(rooms.get(name));
      const r = makeRoom(name);
      return request({ t: "join", room: name }).then(
        (res) => { r._init(res.peers || []); rooms.set(name, r); return r; },
        (e) => { throw { code: "upstream_error", message: e.message }; }
      );
    },
    connected() { return open; },
    peers() { return hall ? hall.peers() : []; },
    onPeers(h) { return hall ? hall.onPeers(h) : () => {}; },
    on(t, h) { return hall ? hall.on(t, h) : () => {}; },
    emit(t, d) { return hall ? hall.emit(t, d) : Promise.resolve(); },
    presence(p) { return hall ? hall.presence(p) : Promise.resolve(); },
    onConnection(h) { connHandlers.add(h); return () => connHandlers.delete(h); },
  };

  // ---------- Base de données ----------
  const copy = (d) => JSON.parse(JSON.stringify(d));
  const meta = { fromCache: false, hasPendingWrites: false };
  const docSnap = (id, d) => ({ id, exists: !!d, data: () => (d ? copy(d) : undefined), metadata: meta });
  function subscribe(kind, path, next) {
    const id = ++subId;
    subs.set(id, {
      kind, path,
      deliver(m) {
        try {
          if (kind === "doc") next(docSnap(path.split("/").pop(), m.doc));
          else { const docs = (m.docs || []).map((x) => docSnap(x.id, x.data)); next({ docs, size: docs.length, empty: !docs.length, metadata: meta, docChanges: () => [] }); }
        } catch (e) { console.error(e); }
      },
    });
    wsSend({ t: "sub", id, kind, path });
    return () => { subs.delete(id); wsSend({ t: "unsub", id }); };
  }
  function docRef(path) {
    const id = path.split("/").pop();
    return {
      id, path,
      get: () => request({ t: "get", path }).then((r) => docSnap(id, r.doc)),
      set: (d) => request({ t: "set", path, data: d }).then(() => {}),
      update: (d) => request({ t: "get", path }).then((r) => { if (!r.doc) throw { code: "invalid_argument", message: "Document absent" }; return request({ t: "set", path, data: { ...r.doc, ...d } }); }).then(() => {}),
      delete: () => request({ t: "del", path }).then(() => {}),
      onSnapshot: (next) => subscribe("doc", path, next),
      collection: (sub) => colRef(path + "/" + sub),
    };
  }
  function colRef(path) {
    const q = {
      path,
      doc: (id) => docRef(path + "/" + (id || Math.random().toString(36).slice(2, 12))),
      limit: () => q, orderBy: () => q, where: () => q,
      get: () => new Promise((res) => { const un = subscribe("col", path, (s) => { un(); res(s); }); }),
      onSnapshot: (next) => subscribe("col", path, next),
      add: (d) => { const r = q.doc(); return r.set(d).then(() => r); },
    };
    return q;
  }
  const db = { doc: docRef, collection: colRef };

  // ---------- Joueurs ----------
  const COLORS = ["#6fb3ff", "#86b86a", "#d6a243", "#e07ad0", "#5fd6c8", "#ff8a4a", "#b59cff", "#f0f0e0"];
  const colorOf = (id) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) | 0; return COLORS[Math.abs(h) % 8]; };
  const avatar = (id, name) => "data:image/svg+xml," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="${colorOf(id)}"/>` +
    `<text x="10" y="14" font-size="11" text-anchor="middle" font-family="sans-serif" fill="#111">${String(name || "?").slice(0, 1).toUpperCase().replace(/[<&>"']/g, "")}</text></svg>`
  );
  const profile = (id) => ({ id, name: id === uid ? nickNow() || names[id] || "" : names[id] || "", avatarUrl: avatar(id, names[id]), color: colorOf(id), email: null, isMe: id === uid, guest: false });
  const user = {
    id: async () => uid,
    isOwner: async () => admin,
    canEdit: async () => admin,
    can: async () => null,
    me: async () => ({ ...profile(uid), isOwner: admin, canEdit: admin }),
    name: async () => nickNow(),
    avatarUrl: async () => avatar(uid, nickNow()),
    email: async () => null,
    profiles: async (ids) => { const out = {}; for (const id of [].concat(ids)) out[id] = profile(id); return out; },
    search: async () => [],
  };

  // ---------- Liens à partager (réservé aux admins) ----------
  function toLinks(r) {
    const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
    const base = r.public || (local ? r.lan : location.origin);
    return { player: base + "/", admin: base + "/?admin=" + r.code, isPublic: !!r.public || !local };
  }
  window.osServer = {
    links: () => request({ t: "links" }).then(toLinks),
    newCode: () => request({ t: "newcode" }).then(toLinks),
    setAdmin: (peer, on) => request({ t: "setadmin", peer, on: !!on }),
  };

  const caps = { db, user, room: lobby };
  window.claude = { use: (n) => helloP.then((ok) => (ok && caps[n]) || null) };
  if (location.protocol === "file:") helloResolve(false);
  else connect();
})();
