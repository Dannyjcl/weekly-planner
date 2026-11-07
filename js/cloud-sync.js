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
  initializeAuth, getAuth, indexedDBLocalPersistence, browserLocalPersistence, browserPopupRedirectResolver,
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail,
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
  // No popup resolver at startup: it would load an iframe from firebaseapp.com,
  // which some networks (e.g. campus Wi-Fi) block. It's only passed to the Google popup.
  let auth;
  try {
    auth = initializeAuth(fbApp, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  } catch (e) {
    auth = getAuth(fbApp);
  }
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
    /** email + password: no popups, works in home-screen apps and on networks that block firebaseapp.com */
    signInEmail: async (email, password, create = false) => {
      return create
        ? createUserWithEmailAndPassword(auth, email, password)
        : signInWithEmailAndPassword(auth, email, password);
    },
    resetPassword: (email) => sendPasswordResetEmail(auth, email),
    /** Google popup: fine on a laptop; unreliable on iPhone home-screen apps and blocked networks */
    signInGoogle: async () => {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      return signInWithPopup(auth, provider, browserPopupRedirectResolver);
    },
    signIn: () => openSignInSheet(api),
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
    if (!api.user) return openSignInSheet(api, { bg, fg });
    if (api.status === "error") return location.reload();
    if (confirm(`Signed in as ${api.user.email}.\n\nSign out on this device? (Your data stays saved here and in the cloud.)`)) api.signOut();
  };
  const add = () => document.body.appendChild(el);
  document.body ? add() : document.addEventListener("DOMContentLoaded", add);
}

/* ── sign-in sheet (email + password, Google as a fallback) ─── */

const AUTH_MSG = {
  "auth/invalid-email": "That email doesn't look right.",
  "auth/missing-password": "Enter a password.",
  "auth/weak-password": "Password needs at least 6 characters.",
  "auth/email-already-in-use": "That email already has an account. Tap Sign in instead.",
  "auth/invalid-credential": "Wrong email or password. New here? Tap Create account.",
  "auth/wrong-password": "Wrong password.",
  "auth/user-not-found": "No account with that email. Tap Create account.",
  "auth/too-many-requests": "Too many tries. Wait a minute and try again.",
  "auth/network-request-failed": "No connection. Check your internet and try again.",
  "auth/operation-not-allowed": "Email sign-in isn't turned on in Firebase yet (Authentication → Sign-in method → Email/Password).",
  "auth/popup-blocked": "Pop-up was blocked. Use email sign-in above.",
};

function openSignInSheet(api, { bg = "#2C2420", fg = "#fff" } = {}) {
  if (document.getElementById("cloudsync-sheet")) return;
  const wrap = document.createElement("div");
  wrap.id = "cloudsync-sheet";
  wrap.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center;font:15px/1.4 system-ui,-apple-system,sans-serif";
  wrap.innerHTML = `
    <form style="background:#fff;color:#222;width:100%;max-width:420px;border-radius:18px 18px 0 0;padding:20px 20px calc(20px + env(safe-area-inset-bottom));box-shadow:0 -6px 30px rgba(0,0,0,.2)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <b style="font-size:18px">Sync across devices</b>
        <button type="button" data-x style="border:none;background:none;font-size:22px;color:#888;cursor:pointer">×</button>
      </div>
      <div style="font-size:13px;color:#777;margin-bottom:14px">Use the same email &amp; password on every device. One account works for both your apps.</div>
      <input name="email" type="email" autocomplete="username" placeholder="Email" required
        style="width:100%;box-sizing:border-box;padding:12px;border:1.5px solid #ddd;border-radius:10px;font-size:16px;margin-bottom:8px">
      <input name="password" type="password" autocomplete="current-password" placeholder="Password (6+ characters)" required minlength="6"
        style="width:100%;box-sizing:border-box;padding:12px;border:1.5px solid #ddd;border-radius:10px;font-size:16px">
      <div data-msg style="font-size:13px;color:#c0392b;min-height:18px;margin:8px 0 4px"></div>
      <div style="display:flex;gap:8px">
        <button type="submit" data-signin style="flex:1;padding:12px;border:none;border-radius:10px;background:${bg};color:${fg};font-weight:700;font-size:15px;cursor:pointer">Sign in</button>
        <button type="button" data-create style="flex:1;padding:12px;border:1.5px solid ${bg};border-radius:10px;background:#fff;color:#222;font-weight:600;font-size:15px;cursor:pointer">Create account</button>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:14px;font-size:13px">
        <a href="#" data-reset style="color:#777">Forgot password?</a>
        <a href="#" data-google style="color:#777">Use Google instead (laptop)</a>
      </div>
    </form>`;
  document.body.appendChild(wrap);
  const form = wrap.querySelector("form");
  const msg = wrap.querySelector("[data-msg]");
  const close = () => wrap.remove();
  const show = (t, ok) => { msg.style.color = ok ? "#2e8b57" : "#c0392b"; msg.textContent = t; };
  const err = (e) => show(AUTH_MSG[e.code] || ("Couldn't sign in: " + (e.code || e.message)));
  const creds = () => [form.email.value.trim(), form.password.value];
  const run = async (fn) => {
    form.querySelectorAll("button").forEach((b) => (b.disabled = true));
    show("Working…", true);
    try { await fn(); close(); } catch (e) { err(e); }
    form.querySelectorAll("button").forEach((b) => (b.disabled = false));
  };
  wrap.addEventListener("click", (e) => { if (e.target === wrap || e.target.closest("[data-x]")) close(); });
  form.addEventListener("submit", (e) => { e.preventDefault(); run(() => api.signInEmail(...creds())); });
  wrap.querySelector("[data-create]").onclick = () => {
    if (!form.reportValidity()) return;
    run(() => api.signInEmail(...creds(), true));
  };
  wrap.querySelector("[data-reset]").onclick = async (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    if (!email) return show("Type your email first, then tap Forgot password.");
    try { await api.resetPassword(email); show("Reset email sent. Check your inbox.", true); } catch (er) { err(er); }
  };
  wrap.querySelector("[data-google]").onclick = (e) => { e.preventDefault(); run(() => api.signInGoogle()); };
  setTimeout(() => form.email.focus(), 50);
}
