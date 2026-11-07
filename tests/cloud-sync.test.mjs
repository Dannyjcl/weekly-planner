// Simulates multiple devices (separate vm contexts / localStorages) against one fake Firestore.
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const SRC = fs.readFileSync(new URL("../js/cloud-sync.js", import.meta.url), "utf8")
  .replace(/^import\s*\{([^}]*)\}\s*from\s*"[^"]+";/gm, (_, names) => `const {${names}} = __fb;`)
  .replace(/export (function|const)/g, "$1")
  + "\n;__out.startCloudSync = startCloudSync;";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function makeServer() {
  const docs = new Map();
  const listeners = new Map(); // path -> Set<{cb, device}>
  return {
    docs,
    read: (p) => docs.get(p),
    write(p, val, device) {
      docs.set(p, structuredClone(val));
      (listeners.get(p) || []).forEach((l) => {
        if (l.device === device) {
          l.cb(snap(val, { hasPendingWrites: true, fromCache: true }));
          setTimeout(() => l.cb(snap(val, { hasPendingWrites: false, fromCache: false })), 5);
        } else setTimeout(() => l.cb(snap(val, { hasPendingWrites: false, fromCache: false })), 10);
      });
    },
    listen(p, device, cb) {
      const s = listeners.get(p) || new Set(); listeners.set(p, s);
      const l = { cb, device }; s.add(l);
      setTimeout(() => cb(snap(docs.get(p), { fromCache: false, hasPendingWrites: false })), 2);
      return () => s.delete(l);
    },
  };
  function snap(val, metadata) {
    return { exists: () => val !== undefined, data: () => structuredClone(val), metadata };
  }
}

function makeDevice(server, name, { appId = "budget", keys = ["a", "b"], prefixes = [], initial = {}, answer = true } = {}) {
  const store = new Map(Object.entries(initial));
  const localStorage = {
    get length() { return store.size; },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  let authCb = null;
  const dev = { name, store, remoteChanges: 0 };
  const fb = {
    initializeApp: () => ({}), getApps: () => [],
    getAuth: () => ({}), GoogleAuthProvider: class { setCustomParameters() {} },
    signInWithPopup: async () => { authCb({ uid: "u1", email: "d@x" }); },
    signInWithRedirect: async () => {}, signOut: async () => authCb(null),
    onAuthStateChanged: (_a, cb) => { authCb = cb; },
    initializeFirestore: () => ({}), getFirestore: () => ({}),
    persistentLocalCache: () => ({}), persistentMultipleTabManager: () => ({}),
    doc: (_db, ...parts) => ({ path: parts.join("/") }),
    onSnapshot: (ref, a, b) => server.listen(ref.path, name, typeof a === "function" ? a : b),
    setDoc: async (ref, val) => { await tick(1); server.write(ref.path, val, name); },
  };
  const ctx = {
    __fb: fb, __out: {}, localStorage, console,
    navigator: { onLine: true }, setTimeout, clearTimeout, Date, Math, JSON, Number, String, Object, Set, Map,
    document: { addEventListener() {}, visibilityState: "visible", body: null },
    location: { reload() { throw new Error("reload"); } }, alert() {}, confirm: () => { dev.asked = (dev.asked || 0) + 1; return answer; },
  };
  ctx.window = { addEventListener() {} };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  dev.api = ctx.__out.startCloudSync({
    appId, keys, prefixes, mount: false,
    summary: () => ({ v: store.get(keys[0]) }),
    onRemoteChange: () => { dev.remoteChanges++; },
  });
  dev.signIn = () => dev.api.signIn();
  dev.set = (k, v) => { store.set(k, v); dev.api.save(); };
  return dev;
}

const settle = () => tick(900);

test("first device uploads its existing data", async () => {
  const s = makeServer();
  const A = makeDevice(s, "A", { initial: { a: "1", b: "2", unrelated: "x" } });
  await A.signIn(); await settle();
  assert.deepEqual(s.read("users/u1/apps/budget").data, { a: "1", b: "2" });
  assert.equal(A.api.status, "synced");
});

test("fresh device with default data takes the cloud copy (no overwrite)", async () => {
  const s = makeServer();
  const A = makeDevice(s, "A", { initial: { a: "real", b: "data" } });
  await A.signIn(); await settle();
  const B = makeDevice(s, "B", { initial: { a: "DEFAULT" } });
  await B.signIn(); await settle();
  assert.equal(B.store.get("a"), "real");
  assert.equal(B.store.get("b"), "data");
  assert.equal(s.read("users/u1/apps/budget").data.a, "real");
  assert.equal(B.remoteChanges, 1);
});

test("live edits flow both ways without ping-pong", async () => {
  const s = makeServer();
  const A = makeDevice(s, "A", { initial: { a: "1" } });
  await A.signIn(); await settle();
  const B = makeDevice(s, "B");
  await B.signIn(); await settle();
  let writes = 0; const orig = s.write; s.write = (...x) => { writes++; orig(...x); };
  A.set("a", "2"); await settle();
  assert.equal(B.store.get("a"), "2");
  B.set("b", "new"); await settle();
  assert.equal(A.store.get("b"), "new");
  // re-saving unchanged data (like renderBudget does) must not write
  A.api.save(); B.api.save(); await settle();
  assert.equal(writes, 2);
});

test("debounce: many keystrokes = one write", async () => {
  const s = makeServer();
  const A = makeDevice(s, "A", { initial: { a: "0" } });
  await A.signIn(); await settle();
  let writes = 0; const orig = s.write; s.write = (...x) => { writes++; orig(...x); };
  for (let i = 1; i <= 10; i++) { A.set("a", String(i)); await tick(50); }
  await settle();
  assert.equal(writes, 1);
  assert.equal(s.read("users/u1/apps/budget").data.a, "10");
});

test("offline edits on a known device are pushed when it signs back in", async () => {
  const s = makeServer();
  const A = makeDevice(s, "A", { initial: { a: "1" } });
  await A.signIn(); await settle();
  await A.api.signOut(); await settle();
  A.set("a", "edited-while-signed-out"); await settle();
  assert.equal(s.read("users/u1/apps/budget").data.a, "1");
  await A.signIn(); await settle();
  assert.equal(s.read("users/u1/apps/budget").data.a, "edited-while-signed-out");
});

test("deleted keys propagate (prefix keys, e.g. planner tasks)", async () => {
  const s = makeServer();
  const opts = { appId: "planner", keys: ["timebudget:v1"], prefixes: ["planner-"] };
  const A = makeDevice(s, "A", { ...opts, initial: { "timebudget:v1": "{}", "planner-2026-11-06": "[1]", "timebudget:ui": "local" } });
  await A.signIn(); await settle();
  const B = makeDevice(s, "B", opts);
  await B.signIn(); await settle();
  assert.equal(B.store.get("planner-2026-11-06"), "[1]");
  assert.equal(B.store.has("timebudget:ui"), false);
  A.store.delete("planner-2026-11-06"); A.api.save(); await settle();
  assert.equal(B.store.has("planner-2026-11-06"), false);
});

test("cross-app watch sees the other app's summary", async () => {
  const s = makeServer();
  const P = makeDevice(s, "P", { appId: "planner", keys: ["p"], initial: { p: "x" } });
  await P.signIn(); await settle();
  const Bd = makeDevice(s, "B", { appId: "budget", keys: ["a"], initial: { a: "1" } });
  const seen = [];
  Bd.api.watchApp("planner", (v) => seen.push(v && v.summary));
  await Bd.signIn(); await settle();
  assert.deepEqual(seen.at(-1), { v: "x" });
  P.set("p2", "ignored-key"); P.set("p", "y"); await settle();
  assert.deepEqual(seen.at(-1), { v: "y" });
});

test("first sync with different real data on both sides asks; Cancel keeps this device", async () => {
  const s = makeServer();
  const A = makeDevice(s, "A", { initial: { a: "demo" } });
  await A.signIn(); await settle();
  const B = makeDevice(s, "B", { initial: { a: "real" }, answer: false });
  await B.signIn(); await settle();
  assert.equal(B.asked, 1);
  assert.equal(s.read("users/u1/apps/budget").data.a, "real");
  assert.equal(A.store.get("a"), "real");              // live-pushed to the other device
  assert.ok(B.store.get("cloudsync:budget:backup"));
});

test("first sync: identical data does not prompt; empty cloud doc gets local data", async () => {
  const s = makeServer();
  s.docs.set("users/u1/apps/budget", { data: {}, updated: 5 });
  const A = makeDevice(s, "A", { initial: { a: "1" } });
  await A.signIn(); await settle();
  assert.equal(A.asked, undefined);
  assert.equal(s.read("users/u1/apps/budget").data.a, "1");
  const B = makeDevice(s, "B", { initial: { a: "1" } });
  await B.signIn(); await settle();
  assert.equal(B.asked, undefined);
});
