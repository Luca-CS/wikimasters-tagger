// Faux chrome.* pour faire tourner le content script dans une page de test ordinaire :
// stockage en mémoire (window.__store) avec événements onChanged, runtime minimal (messages
// enregistrés dans window.__msgs). Chargé avant les scripts de l'extension.
(function () {
  const listeners = [];
  const store = (window.__store = {});
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  window.__msgs = [];
  window.__drives = [];
  let driveSeq = 0;
  const driveWait = new Map();
  window.__wmtDriveReply = (id, res) => {
    const resolve = driveWait.get(id);
    driveWait.delete(id);
    if (resolve) resolve(res);
  };
  window.chrome = {
    storage: {
      local: {
        async get(keys) {
          const ks = keys == null ? Object.keys(store) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          const out = {};
          for (const k of ks) if (k in store) out[k] = clone(store[k]);
          return out;
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: store[k], newValue: clone(v) };
            store[k] = clone(v);
          }
          setTimeout(() => listeners.forEach((l) => l(changes, "local")));
        },
        async remove(keys) {
          const changes = {};
          for (const k of [].concat(keys)) {
            changes[k] = { oldValue: store[k] };
            delete store[k];
          }
          setTimeout(() => listeners.forEach((l) => l(changes, "local")));
        },
        async getBytesInUse() {
          return JSON.stringify(store).length;
        },
      },
      onChanged: { addListener: (f) => listeners.push(f) },
    },
    runtime: {
      id: "harness", // sans id, le content script se croirait orphelin (extension rechargée)
      getManifest: () => ({ version: "harness" }),
      getURL: (p) => "/ext/" + p,
      async sendMessage(msg) {
        // Pilote (vrais clics) : relayé à cdp.mjs, qui envoie Input.dispatch* à cette page,
        // comme le ferait lib/driver.js avec chrome.debugger.
        if (msg && msg.type === "drive") {
          window.__drives.push(msg.op);
          if (!window.__wmtDrive) return { ok: false, error: "pas de pilote dans ce banc de test" };
          const id = ++driveSeq;
          return new Promise((resolve) => {
            driveWait.set(id, resolve);
            window.__wmtDrive(JSON.stringify({ id, msg }));
          });
        }
        window.__msgs.push(msg);
        return { ok: true };
      },
      onMessage: { addListener() {} },
      openOptionsPage() {},
    },
  };
})();
