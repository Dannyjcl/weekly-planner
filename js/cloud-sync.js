/*
 * cloud-sync.js: shared Firebase sync for Daniel's apps (Semester Budget + TimeBudget planner).
 *
 * How it works
 *   - Each app keeps using localStorage exactly as before. This module mirrors the
 *     chosen localStorage keys to Firestore at  users/{uid}/apps/{appId}.
 *   - Live: a Firestore listener pulls changes made on other devices as they happen.
 *   - Safe: a device that has never synced always takes the cloud copy first (so a
 *     fresh device can't overwrite real data with defaults). After that, unsynced
 *     local edits are pushed, and if both sides changed, the newer one wins.
 *   - Cross-app: each app publishes a small `summary`, and any app can read or
 *     watch another app's doc with CloudSync.watchApp('budget' | 'planner', cb).
 *   - Both apps live on dannyjcl.github.io, so one Google sign-in covers both.
 *
 * Usage (from a <script type="module">):
 *   import { startCloudSync } from './cloud-sync.js';
 *   startCloudSync({ appId: 'budget', keys: ['sb-income', ...], summary: () => ({...}),
 *                    onRemoteChange: () => reloadFromStorage() });
 *   // then call window.CloudSync.save() whenever the app writes localStorage.
 */
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, onSnapshot, setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export const firebaseConfig = {
  apiKey: "AIzaSyBsYESd0Wwft53I8S0Irbki4R7fFExyMF4",
  authDomain: "semester-budget.firebaseapp.com",
  projectId: "semester-budget",
  storageBucket: "semester-budget.firebasestorage.app",
  messagingSenderId: "287172677747",
  appId: "1:287172677747:web:429f65abd31148cf3bda06",
  measurementId: "G-94RGBBQCEM",
};

const DEBOUNCE_MS = 700;

/* ── small helpers ─────────────────────────────────────── */

function hash(str) {                       // FNV-1a, enough to detect "did anything change"
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ":" + str.length;
}

function deviceId() {
  let id = localStorage.getItem("cloudsync:device");
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("cloudsync:device", id);
  }
  return id;
}

/* ── main ──────────────────────────────────────────────── */

export function startCloudSync(opts) {
  const { appId, keys = [], prefixes = [], summary, onRemoteChange, mount = true } = opts;
  const META = (k) => `cloudsync:${appId}:${k}`;   // per-app bookkeeping (never synced itself)
  const owns = (k) => keys.includes(k) || prefixes.some((p) => k.startsWith(p));

  const fbApp = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  const auth = getAuth(fbApp);
  let db;
  try {
    db = initializeFirestore(fbApp, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (e) {
    db = getFirestore(fbApp);                // already initialised, or no IndexedDB
  }

  const me = deviceId();
  let user = null;
  let ref = null;
  let unsubDoc = null;
  let timer = null;
  let firstSnap = true;
  let status = "signed-out";
  const statusListeners = new Set();
  const watchers = new Map();                 // otherAppId -> { cbs:Set, unsub }

  /* local snapshot of the keys this app owns, in a stable order */
  function readLocal() {
    const out = {};
    const names = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && owns(k)) names.push(k);
    }
    names.sort().forEach((k) => { out[k] = localStorage.getItem(k); });
    return out;
  }
  const localHash = () => hash(JSON.stringify(readLocal()));
  const syncedHash = () => localStorage.getItem(META("hash"));
  const syncedAt = () => Number(localStorage.getItem(META("synced"))) || 0;
  const changedAt = () => Number(localStorage.getItem(META("changed"))) || 0;
  const isDirty = () => localHash() !== syncedHash();

  function setStatus(s) {
    status = s;
    statusListeners.forEach((fn) => { try { fn(s, user); } catch (e) { console.error(e); } });
  }

  /* replace this app's local keys with the cloud copy */
  function applyCloud(cloud) {
    const data = cloud.data || {};
    const local = readLocal();
    let changed = false;
    Object.keys(local).forEach((k) => {
      if (!(k in data)) { localStorage.removeItem(k); changed = true; }
    });
    Object.keys(data).forEach((k) => {
      if (owns(k) && localStorage.getItem(k) !== data[k]) { localStorage.setItem(k, data[k]); changed = true; }
    });
    localStorage.setItem(META("hash"), localHash());
    localStorage.setItem(META("synced"), String(cloud.updated || 0));
    localStorage.setItem(META("changed"), String(cloud.updated || 0));
    return changed;
  }

  async function push() {
    if (!ref) return;
    const data = readLocal();
    const h = hash(JSON.stringify(data));
    const updated = Date.now();
    let sum = null;
    try { sum = summary ? summary() : null; } catch (e) { console.warn("summary failed", e); }
    setStatus(navigator.onLine === false ? "offline" : "saving");
    try {
      await setDoc(ref, { data, summary: sum, updated, device: me });
      // only record as synced if nothing changed while the write was in flight
      if (localHash() === h) {
        localStorage.setItem(META("hash"), h);
        localStorage.setItem(META("synced"), String(updated));
      } else {
        schedule();
      }
      setStatus("synced");
    } catch (e) {
      console.error("Cloud save failed:", e);
      setStatus("error");
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!isDirty()) return;
    localStorage.setItem(META("changed"), String(Date.now()));
    if (ref && !firstSnap) push();
  }

  /* first snapshot after sign-in: decide who wins */
  function reconcile(snap) {
    const exists = snap.exists();
    const cloud = exists ? snap.data() : null;
    const local = readLocal();
    const hasLocal = Object.keys(local).length > 0;
    const neverSynced = syncedHash() === null;

    if (!exists) {
      if (hasLocal) push(); else setStatus("synced");
      return;
    }
    const cloudNewer = (cloud.updated || 0) > syncedAt();
    const dirty = isDirty();

    if (neverSynced) {
      // First sync on this device. Default: take the cloud copy (so a fresh device's
      // demo/default data never overwrites real data). If both sides hold different
      // real data, ask, and keep a local backup either way.
      const cloudData = cloud.data || {};
      const cloudEmpty = Object.keys(cloudData).length === 0;
      const same = hash(JSON.stringify(local)) === hash(JSON.stringify(cloudData));
      if (cloudEmpty && hasLocal) { push(); return; }
      if (hasLocal && !same) {
        localStorage.setItem(META("backup"), JSON.stringify({ at: Date.now(), data: local }));
        const when = cloud.updated ? new Date(cloud.updated).toLocaleString() : "earlier";
        const useCloud = confirm(
          `Your cloud already has ${appId} data (last saved ${when}) that's different from what's on this device.\n\n` +
          `OK = load the cloud data onto this device (recommended if this is a new device).\n` +
          `Cancel = keep THIS device's data and upload it, replacing the cloud copy.\n\n` +
          `(This device's current data is backed up locally either way.)`);
        if (!useCloud) { localStorage.setItem(META("changed"), String(Date.now())); push(); return; }
      }
      if (applyCloud(cloud)) notifyRemote();
      setStatus("synced");
      return;
    }
    if (cloudNewer && dirty) {
      // Both sides changed while apart: newest edit wins.
      if (changedAt() > (cloud.updated || 0)) push();
      else { if (applyCloud(cloud)) notifyRemote(); setStatus("synced"); }
      return;
    }
    if (cloudNewer) { if (applyCloud(cloud)) notifyRemote(); setStatus("synced"); return; }
    if (dirty) { push(); return; }
    setStatus("synced");
  }

  function notifyRemote() {
    try { onRemoteChange && onRemoteChange(); } catch (e) { console.error(e); location.reload(); }
  }

  function onDoc(snap) {
    if (firstSnap) {
      if (snap.metadata.fromCache && navigator.onLine !== false) return;   // wait for the server's answer
      firstSnap = false;
      reconcile(snap);
      return;
    }
    if (snap.metadata.hasPendingWrites || !snap.exists()) return;          // our own write echoing back
    const cloud = snap.data();
    if (cloud.device === me) return;                                      // written by this device
    if ((cloud.updated || 0) <= syncedAt()) return;
    if (isDirty() && changedAt() > (cloud.updated || 0)) { push(); return; }
    if (applyCloud(cloud)) notifyRemote();
    setStatus("synced");
  }

  function startWatcher(otherId, entry) {
    if (!user) return;
    entry.unsub = onSnapshot(doc(db, "users", user.uid, "apps", otherId), (snap) => {
      const val = snap.exists() ? snap.data() : null;
      entry.cbs.forEach((cb) => { try { cb(val); } catch (e) { console.error(e); } });
    }, (err) => console.warn("watch " + otherId, err));
  }

  onAuthStateChanged(auth, (u) => {
    if (unsubDoc) { unsubDoc(); unsubDoc = null; }
    watchers.forEach((w) => { if (w.unsub) { w.unsub(); w.unsub = null; } });
    user = u;
    if (!u) {
      ref = null;
      setStatus("signed-out");
      watchers.forEach((w) => w.cbs.forEach((cb) => cb(null)));
      return;
    }
    ref = doc(db, "users", u.uid, "apps", appId);
    firstSnap = true;
    setStatus("connecting");
    unsubDoc = onSnapshot(ref, { includeMetadataChanges: true }, onDoc, (err) => {
      console.error("Cloud listener error:", err);
      setStatus("error");
    });
    watchers.forEach((w, id) => startWatcher(id, w));
  });

  // push any pending edit before the page is hidden or closed (important on phones)
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  window.addEventListener("pagehide", flush);
  window.addEventListener("online", () => { if (user) { setStatus("saving"); flush(); if (!isDirty()) setStatus("synced"); } });
  window.addEventListener("offline", () => { if (user) setStatus("offline"); });

  const api = {
    /** call after every localStorage write; batches and uploads */
    save: schedule,
    signIn: async () => {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      try {
        await signInWithPopup(auth, provider);
      } catch (e) {
        if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
          return signInWithRedirect(auth, provider);
        }
        if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
          alert("Sign-in failed: " + (e.code || e.message));
        }
      }
    },
    signOut: () => { flush(); return signOut(auth); },
    get user() { return user; },
    get status() { return status; },
    onStatus(fn) { statusListeners.add(fn); fn(status, user); return () => statusListeners.delete(fn); },
    /** undo a first-sync replace: CloudSync.restoreBackup() in the browser console */
    restoreBackup() {
      const b = JSON.parse(localStorage.getItem(META("backup")) || "null");
      if (!b) return "no backup";
      Object.keys(readLocal()).forEach((k) => localStorage.removeItem(k));
      Object.entries(b.data).forEach(([k, v]) => localStorage.setItem(k, v));
      notifyRemote(); schedule();
      return "restored backup from " + new Date(b.at).toLocaleString();
    },
    /** live view of another app's doc: cb({summary, data, updated}) or cb(null) */
    watchApp(otherId, cb) {
      let w = watchers.get(otherId);
      if (!w) { w = { cbs: new Set(), unsub: null }; watchers.set(otherId, w); startWatcher(otherId, w); }
      w.cbs.add(cb);
      if (!user) cb(null);
      return () => w.cbs.delete(cb);
    },
  };
  window.CloudSync = api;
  if (mount) mountPill(api, opts.pill || {});
  return api;
}

/* ── floating sync status pill ─────────────────────────── */

function mountPill(api, { bg = "#2C2420", fg = "#fff", position = "bottom" } = {}) {
  const el = document.createElement("button");
  el.type = "button";
  el.id = "cloudsync-pill";
  el.style.cssText = [
    "position:fixed", "right:14px", position === "top" ? "top:12px" : "bottom:14px", "z-index:9999",
    `background:${bg}`, `color:${fg}`, "border:none", "border-radius:999px", "padding:8px 14px",
    "font:600 12px/1 system-ui,-apple-system,sans-serif", "box-shadow:0 4px 14px rgba(0,0,0,.18)",
    "cursor:pointer", "opacity:.92", "display:flex", "gap:6px", "align-items:center",
    "margin-bottom:env(safe-area-inset-bottom)",
  ].join(";");
  const LABEL = {
    "signed-out": "☁︎ Sign in to sync",
    connecting: "☁︎ Connecting…",
    saving: "☁︎ Saving…",
    synced: "✓ Synced",
    offline: "☁︎ Offline, will sync",
    error: "⚠︎ Sync error, tap",
  };
  api.onStatus((s) => { el.textContent = LABEL[s] || s; });
  el.onclick = () => {
    if (!api.user) return api.signIn();
    if (api.status === "error") return location.reload();
    if (confirm(`Signed in as ${api.user.email}.\n\nSign out on this device? (Your data stays saved here and in the cloud.)`)) api.signOut();
  };
  const add = () => document.body.appendChild(el);
  document.body ? add() : document.addEventListener("DOMContentLoaded", add);
}
