// Actions dans la page (côté content script) : vrais clics et vraies touches envoyés par le
// pilote du service worker (lib/driver.js, chrome.debugger), pour tous les formats de fenêtre.
//
// - Un clic vise un point de l'élément réellement cliquable : l'élément est d'abord amené dans
//   la zone visible (scrollIntoView, conteneurs défilants compris), puis on cherche, parmi
//   plusieurs points de l'élément, un point où document.elementFromPoint tombe bien sur lui
//   (pas sous la barre de sélection, un bandeau ou le bord de la fenêtre). Le panneau de
//   l'extension est transparent aux clics pendant ce temps.
// - Échelle : les coordonnées du protocole peuvent différer des coordonnées CSS (zoom du
//   navigateur). Avant le premier clic, un calque transparent plein écran de l'extension reçoit
//   un clic de mesure : on compare le point envoyé au point reçu. Ce clic ne touche jamais le site.
// - `ours()` : vrai pendant nos propres actions (elles sont « isTrusted » comme les tiennes).
(function (root) {
  const WMT = (root.WMT = root.WMT || {});
  let scale = null; // {x, y} : coordonnées du protocole / coordonnées CSS
  let busy = 0;
  let lastAt = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class DriveError extends Error {}

  async function call(msg) {
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "drive", ...msg });
    } catch (e) {
      throw new DriveError(`pilote injoignable (${(e && e.message) || e})`);
    }
    if (!res || !res.ok) throw new DriveError((res && res.error) || "pilote : pas de réponse");
    return res;
  }

  /** Nos événements : pendant une action, et 300 ms après (événements tardifs du site). */
  const ours = () => busy > 0 || Date.now() - lastAt < 300;

  async function around(fn) {
    busy++;
    try {
      return await fn();
    } finally {
      busy--;
      lastAt = Date.now();
    }
  }

  function host() {
    return document.getElementById("wmt-host");
  }

  /** Panneau de l'extension transparent aux clics pendant `fn`. */
  async function throughPanel(fn) {
    const h = host();
    const before = h ? h.style.pointerEvents : "";
    if (h) h.style.setProperty("pointer-events", "none", "important");
    try {
      return await fn();
    } finally {
      if (h) h.style.pointerEvents = before;
    }
  }

  async function calibrate() {
    const layer = document.createElement("div");
    layer.dataset.wmtCalibration = "";
    layer.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:transparent;pointer-events:auto";
    const stop = (e) => e.stopPropagation();
    for (const t of ["mousedown", "mouseup", "pointerup", "click"]) layer.addEventListener(t, stop);
    document.documentElement.append(layer);
    const x = Math.round(innerWidth / 2) + 0.5;
    const y = Math.round(innerHeight / 2) + 0.5;
    try {
      const got = new Promise((resolve) => layer.addEventListener("pointerdown", (e) => { e.stopPropagation(); resolve(e); }, { once: true }));
      await around(() => call({ op: "click", x, y }));
      const e = await Promise.race([got, sleep(3000).then(() => null)]);
      if (!e) throw new DriveError("clic de mesure non reçu (onglet en veille ?)");
      scale = { x: e.clientX ? x / e.clientX : 1, y: e.clientY ? y / e.clientY : 1 };
      if (Math.abs(scale.x - 1) > 0.01 || Math.abs(scale.y - 1) > 0.01) console.info("[WikiMasters Tagger] échelle des clics :", scale);
    } finally {
      layer.remove();
    }
  }

  const inside = (el, x, y) => {
    const top = document.elementFromPoint(x, y);
    return !!top && (top === el || el.contains(top));
  };

  /** Point cliquable de `el` (coordonnées CSS), en le faisant défiler au besoin. */
  function hitPoint(el) {
    const tryPoints = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      const xs = [0.5, 0.3, 0.7, 0.15, 0.85];
      const ys = [0.5, 0.3, 0.7, 0.15, 0.85];
      for (const fy of ys) {
        for (const fx of xs) {
          const x = r.left + r.width * fx;
          const y = r.top + r.height * fy;
          if (x < 1 || y < 1 || x > innerWidth - 1 || y > innerHeight - 1) continue;
          if (inside(el, x, y)) return { x, y };
        }
      }
      return null;
    };
    let pt = tryPoints();
    if (!pt) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      pt = tryPoints();
    }
    return pt;
  }

  function describe(el) {
    if (!el) return "rien";
    const t = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
    return `<${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}>${t ? " « " + t + " »" : ""}`;
  }

  /** Vrai clic sur `el`. `what` nomme l'élément dans les messages d'erreur. */
  async function click(el, what = "élément") {
    if (!el || !el.isConnected) throw new DriveError(`${what} introuvable`);
    if (!scale) await calibrate();
    await throughPanel(async () => {
      let pt = hitPoint(el);
      if (!pt) {
        await sleep(250); // défilement doux ou mise en page en cours
        pt = hitPoint(el);
      }
      if (!pt) {
        const r = el.getBoundingClientRect();
        const cover = document.elementFromPoint(Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1), Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1));
        throw new DriveError(`${what} non cliquable : masqué par ${describe(cover)} (fenêtre ${innerWidth}×${innerHeight})`);
      }
      await around(() => call({ op: "click", x: pt.x * scale.x, y: pt.y * scale.y }));
    });
  }

  /** Vraie touche (Enter, Escape, Backspace) sur l'élément qui a le focus. */
  const key = (name) => around(() => call({ op: "key", key: name }));

  /** Saisit `value` dans `input` : clic dessus, texte sélectionné, frappe réelle. */
  async function type(input, value, what = "champ") {
    await click(input, what);
    if (document.activeElement !== input) input.focus();
    input.select();
    await around(() => call({ op: "text", text: String(value) }));
  }

  /** Attache le pilote (émulation du focus) : à appeler au début de chaque automatisme. */
  const attach = () => around(() => call({ op: "attach" }));
  const detach = () => call({ op: "detach" }).catch(() => {});

  WMT.act = { click, key, type, attach, detach, ours, DriveError, resetScale: () => (scale = null) };
})(globalThis);
