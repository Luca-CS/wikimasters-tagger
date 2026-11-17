// Pilote du navigateur par le protocole DevTools (chrome.debugger), côté service worker.
//
// Toutes les actions de l'extension dans le jeu passent par ici : de vrais clics souris et de
// vraies touches (Input.dispatch*, « isTrusted » pour le site), là où les clics JavaScript
// (element.click()) sont ignorés. Tant qu'il est attaché à l'onglet WikiMasters, le pilote
// active aussi l'émulation du focus : l'onglet se comporte comme affiché et actif même s'il
// est en arrière-plan, dans une fenêtre réduite ou recouverte (minuteurs à pleine vitesse,
// animations qui avancent), mesuré le 17/11/2026 dans Edge et Chrome.
//
// Chrome affiche un bandeau « … a commencé à déboguer ce navigateur » tant que le pilote est
// attaché : le fermer détache le pilote, et le content script arrête alors ce qui tournait.
//
// Le content script envoie {type: "drive", op, …} ; réponse {ok, …} ou {ok: false, error}.
(function (root) {
  const WMT = (root.WMT = root.WMT || {});
  const VERSION = "1.3";
  const attached = new Map(); // tabId -> {since}
  const pending = new Map(); // tabId -> Promise d'attachement en cours

  const send = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

  /** Onglet affiché et actif pour la page, même en arrière-plan (réappliqué à chaque appel). */
  const keepActive = (tabId) => send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });

  async function attach(tabId) {
    if (attached.has(tabId)) return keepActive(tabId);
    if (pending.has(tabId)) return pending.get(tabId);
    const p = (async () => {
      try {
        await chrome.debugger.attach({ tabId }, VERSION);
      } catch (e) {
        // Déjà attaché par cette extension (service worker redémarré) : on réutilise.
        if (!/already attached/i.test(String(e && e.message))) throw e;
      }
      await keepActive(tabId);
      // Page « active » pour le cycle de vie : jamais gelée en arrière-plan.
      await send(tabId, "Page.setWebLifecycleState", { state: "active" }).catch(() => {});
      attached.set(tabId, { since: Date.now() });
    })();
    pending.set(tabId, p);
    try {
      await p;
    } finally {
      pending.delete(tabId);
    }
  }

  async function detach(tabId) {
    if (!attached.has(tabId)) return;
    attached.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }

  /**
   * Clic gauche réel en (x, y), coordonnées du protocole. Le content script les calcule depuis
   * les coordonnées CSS de la page, avec l'échelle qu'il a mesurée (zoom du navigateur).
   */
  async function click(tabId, X, Y) {
    await attach(tabId);
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: X, y: Y, button: "none", buttons: 0 });
    await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: X, y: Y, button: "left", buttons: 1, clickCount: 1 });
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: X, y: Y, button: "left", buttons: 0, clickCount: 1 });
  }

  const KEYS = {
    Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
    Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
  };

  async function key(tabId, name) {
    await attach(tabId);
    const k = KEYS[name];
    if (!k) throw new Error(`touche inconnue : ${name}`);
    const base = { key: name, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, nativeVirtualKeyCode: k.windowsVirtualKeyCode };
    await send(tabId, "Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
    await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async function text(tabId, value) {
    await attach(tabId);
    await send(tabId, "Input.insertText", { text: String(value) });
  }

  /** Traite un message {type: "drive"} d'un content script. */
  async function handle(msg, sender) {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId == null) return { ok: false, error: "onglet inconnu" };
    try {
      if (msg.op === "attach") await attach(tabId);
      else if (msg.op === "detach") await detach(tabId);
      else if (msg.op === "click") await click(tabId, +msg.x, +msg.y);
      else if (msg.op === "key") await key(tabId, msg.key);
      else if (msg.op === "text") await text(tabId, msg.text);
      else return { ok: false, error: `opération inconnue : ${msg.op}` };
      return { ok: true, attached: attached.has(tabId) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /** Le pilote a été détaché (bandeau fermé, onglet fermé, DevTools…) : prévenir l'onglet. */
  function onDetach(source, reason) {
    if (source.tabId == null || !attached.has(source.tabId)) return;
    attached.delete(source.tabId);
    chrome.tabs.sendMessage(source.tabId, { type: "driveDetached", reason }).catch(() => {});
  }

  WMT.driver = { handle, onDetach, attach, detach, isAttached: (tabId) => attached.has(tabId) };
})(globalThis);
