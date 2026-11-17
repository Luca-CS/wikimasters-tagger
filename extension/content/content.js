// Content script WikiMasters :
// - page Collection : panneau « Tagger », analyse de toutes les pages (lecture du DOM + clic sur
//   « Suivant → », avec une pause entre deux pages), surlignage des cartes à étiqueter et, à ta
//   demande, pose des étiquettes suggérées sur toute la collection (étiquettes existantes seulement) ;
// - page Paquets : relevé du compteur de paquets (pour les rappels), étiquettes suggérées pour
//   les cartes tirées, défilement et enchaînement des paquets lancés par ton clic sur « Ouvrir ».
(() => {
  if (window.top !== window || window.__wmtLoaded) return;
  window.__wmtLoaded = true;

  const { core, dom, store, packs, act } = WMT;
  const ROUTES = { "/collection": "collection", "/pulls": "pulls" };
  const routeOf = () => ROUTES[location.pathname.replace(/\/+$/, "")] || null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtDate = (t) =>
    new Date(t).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;
  class Aborted extends Error {}

  let config = null; // {rules, themes, settings}
  let rules = []; // règles compilées
  let wd = null; // cache Wikidata
  let scanMeta = null; // {at, n, pages}
  let packsState = null; // dernier relevé du compteur de paquets
  let memo = new Map(); // "titre\ndescription" -> suggestions
  let route = null; // page gérée affichée : "collection", "pulls" ou null
  let ui = null;
  let observer = null;
  let refreshTimer = 0;
  let packsTimer = 0;
  let scanning = null; // {abort}
  let focusTag = null;

  // --- État ------------------------------------------------------------------------

  async function loadState() {
    config = await store.getConfig();
    rules = core.compileRules(config.rules);
    wd = await store.get("wd");
    scanMeta = await store.get("scanMeta");
    packsState = await store.get("packs");
    tagResume = await store.get("tagRun");
    pilot = (await store.get("pilot")) || { pending: [] };
    memo = new Map();
  }

  store.onChange(async (ch) => {
    try {
      if (ch.config) {
        config = await store.getConfig();
        rules = core.compileRules(config.rules);
        memo = new Map();
        if (route === "pulls") pilotOn() ? startPilot() : pausePilot();
      }
      if (ch.wd) {
        wd = ch.wd.newValue || null;
        memo = new Map();
      }
      if (ch.scanMeta) scanMeta = ch.scanMeta.newValue || null;
      if (ch.packs) packsState = ch.packs.newValue || null;
      if (ch.tagRun) tagResume = ch.tagRun.newValue || null;
      if (ch.pilot) pilot = ch.pilot.newValue || { pending: [] };
      if (route) {
        renderPanel();
        scheduleRefresh();
      }
    } catch {
      /* extension rechargée : ce script n'est plus valide */
    }
  });

  /** Appel à l'API de l'extension ; signale si l'extension a été rechargée entre-temps. */
  async function safe(fn) {
    try {
      return await fn();
    } catch (e) {
      if (/context invalidated/i.test(String(e && e.message))) note("L'extension a été mise à jour : recharge la page (F5).", "err");
      else console.warn("[WikiMasters Tagger]", e);
      return undefined;
    }
  }

  const knownTags = () => new Set([...config.rules, ...config.themes].map((r) => r.name));
  const colorOf = (tag) => (config.rules.find((r) => r.name === tag) || {}).color || "#34d399";

  /** Étiquettes à poser (catégorie si la carte n'en a pas, Shiny sur une carte shiny). */
  function suggestionsFor(card) {
    const key = [card.title, card.desc, card.tags.join("\u0001"), card.shiny ? "✦" : ""].join("\n");
    if (!memo.has(key)) {
      const on = config.settings.wikidata && wd;
      memo.set(key, core.suggest(card, rules, on ? core.wdText(wd, card.title) : "", on ? core.wdNature(wd, card.title) : null));
    }
    return memo.get(key);
  }

  // --- Surlignage ------------------------------------------------------------------

  function unpaint(root) {
    delete root.dataset.wmt;
    root.style.removeProperty("--wmt-c");
    root.querySelectorAll("[data-wmt-ring]").forEach((e) => delete e.dataset.wmtRing);
    root.querySelectorAll(":scope > .wmt-flags").forEach((e) => e.remove());
  }

  function paint(card, matches) {
    const shown = focusTag ? matches.filter((m) => m.tag === focusTag) : matches;
    const style = config.settings.highlightStyle;
    const sig = shown.length ? `${card.title}|${shown.map((m) => m.tag + colorOf(m.tag)).join(",")}|${style}` : "";
    if ((card.root.dataset.wmt || "") === sig) return;
    unpaint(card.root);
    if (!sig) return;
    card.root.dataset.wmt = sig;
    card.root.style.setProperty("--wmt-c", colorOf(shown[0].tag));
    if (style !== "flag") card.el.dataset.wmtRing = "";
    const flags = h("div", { class: "wmt-flags" });
    for (const m of shown.slice(0, 2)) {
      const chip = h("span", { class: "wmt-chip", title: `À étiqueter : ${m.tag}\nMotifs : ${m.hits.join(", ")}` }, m.tag);
      chip.style.setProperty("--wmt-c", colorOf(m.tag));
      flags.append(chip);
    }
    if (shown.length > 2) {
      flags.append(h("span", { class: "wmt-chip wmt-more", title: shown.slice(2).map((m) => m.tag).join(", ") }, `+${shown.length - 2}`));
    }
    card.root.append(flags);
  }

  function clearHighlights() {
    document.querySelectorAll("[data-wmt]").forEach(unpaint);
  }

  /** Reprend les couleurs des étiquettes du jeu (sauf couleur choisie à la main dans la config). */
  function syncColors(seen) {
    const stale = config.rules.some((r) => seen[r.name] && !r.colorLocked && r.color !== seen[r.name]);
    if (!stale) return;
    config = {
      ...config,
      rules: config.rules.map((r) => (seen[r.name] && !r.colorLocked ? { ...r, color: seen[r.name] } : r)),
    };
    safe(() => store.saveConfig(config));
  }

  function refresh() {
    if (!route) return;
    const cards = dom.cards(document, knownTags());
    const colors = {};
    cards.forEach((c) => Object.assign(colors, c.colors));
    syncColors(colors);
    if (route === "pulls") return refreshPulls(cards);
    const perTag = new Map();
    let todo = 0;
    for (const c of cards) {
      const matches = suggestionsFor(c);
      if (matches.length) todo++;
      for (const m of matches) perTag.set(m.tag, (perTag.get(m.tag) || 0) + 1);
      paint(c, config.settings.highlight ? matches : []);
    }
    renderPage(cards.length, todo, perTag);
  }

  // --- Page Paquets : cartes tirées ----------------------------------------------------

  let pulled = new Map(); // titre -> {card, matches}, pour l'ouverture de paquet en cours
  let revealing = false;

  // Une carte n'est analysée qu'une fois visible : pas de divulgâchage pendant l'ouverture.
  const isVisible = (el) =>
    el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.offsetParent !== null;

  function refreshPulls(cards) {
    const shown = dom.reveal();
    if (shown && !revealing) {
      pulled = new Map(); // nouvelle ouverture de paquet
      autoStopped = false;
      if (!dom.blockingDialog()) note(null); // l'ancien message (fin d'enchaînement…) disparaît
    }
    revealing = !!shown;
    for (const c of cards) capturePulled(c, isVisible(c.el));
    renderPulled(shown);
    updatePacks();
    if (shown && config.settings.autoReveal && !autoRun && !autoStopped && !orphaned) autoReveal();
  }

  /** Analyse une carte tirée (si visible) et la surligne. */
  function capturePulled(c, visible) {
    if (!visible) return paint(c, []);
    // L'écran d'ouverture affiche l'extrait complet : on ne garde que la phrase de définition.
    const card = { ...c, desc: dom.firstSentence(c.desc) };
    const matches = suggestionsFor(card);
    pulled.set(card.title, { card, matches });
    paint(c, config.settings.highlight ? matches : []);
    pilotRemember(card, matches);
  }

  // --- Défilement automatique et enchaînement des ouvertures ---------------------------
  // Défilement : une fois un paquet ouvert, fait défiler ses cartes puis clique sur « Continuer ».
  // Enchaînement : démarre UNIQUEMENT sur ton propre appui sur « Ouvrir » (clic ou Entrée), puis
  // rouvre tant qu'il reste des paquets parmi ceux disponibles à ce moment-là (jamais ceux
  // rechargés entre-temps). Dans les deux cas : pause tant qu'une vérification (« je ne suis pas
  // un robot »…) est affichée, sans jamais y toucher, pause si l'onglet n'est pas visible, arrêt
  // dès que tu cliques ou tapes une touche (les mouvements du curseur ne comptent pas).

  let autoRun = null; // {abort} : défilement du paquet en cours
  let autoStopped = false; // défilement arrêté pour le paquet en cours
  let chain = null; // {abort, left, total} : enchaînement lancé par ton appui sur « Ouvrir »
  const rhythm = WMT.rhythm.createRhythm();
  const CHAIN_PAUSE = 300; // ms avant de rouvrir, comme un humain qui enchaîne
  const log = (...args) => console.info("[WikiMasters Tagger]", ...args);

  // Pilote (lib/act.js → lib/driver.js) : attaché tant qu'un automatisme tourne, détaché 5 s
  // après le dernier (le bandeau « débogage » de Chrome disparaît alors).
  let holds = 0;
  let detachTimer = 0;
  async function hold() {
    clearTimeout(detachTimer);
    holds++;
    try {
      await act.attach();
    } catch (e) {
      release();
      throw new Error(`pilote indisponible : ${e.message}`);
    }
  }
  function release() {
    holds = Math.max(0, holds - 1);
    clearTimeout(detachTimer);
    if (!holds) detachTimer = setTimeout(() => !holds && act.detach(), 5000);
  }

  async function wait(job, ms) {
    const end = Date.now() + ms;
    while (!job.abort && Date.now() < end) await sleep(Math.min(50, end - Date.now()));
  }

  async function waitFor(job, test, ms) {
    const end = Date.now() + ms;
    while (!job.abort && Date.now() < end) {
      if (test()) return true;
      await sleep(50);
    }
    return false;
  }

  const paused = () => document.hidden || dom.blockingDialog();
  let pauseShown = false;

  /** Message de pause : vérification « robot », fenêtre du site ou onglet masqué. */
  function showPause(on) {
    if (on === pauseShown) return;
    pauseShown = on;
    if (on && !document.hidden) {
      const what = dom.blockingText();
      log("pause :", what || "fenêtre du site affichée");
      if (pilotOn()) pilotAlert(`Pause : ${what || "une fenêtre du site est affichée"}. Le pilote reprendra quand elle aura disparu.`);
      note("Pause : une fenêtre du site est affichée (vérification, annonce…). Ça reprend tout seul quand elle disparaît.", "warn");
    } else if (!on) {
      note(null);
    }
  }

  /** Attend la fin d'une vérification, d'une fenêtre du site, et que l'onglet soit visible. */
  async function waitReady(job) {
    if (!paused()) return;
    while (!job.abort && paused()) {
      showPause(true);
      await sleep(300);
    }
    showPause(false);
    if (!job.abort) await wait(job, 500);
  }

  /**
   * Attend `test()` pendant `ms` de temps « actif » : le chrono s'arrête tant qu'une fenêtre du
   * site est affichée ou que l'onglet est masqué (une annonce de quelques secondes ne fait donc
   * plus échouer l'attente). Renvoie false tout de suite en cas de sanction.
   */
  async function waitActive(job, test, ms) {
    let left = ms;
    while (!job.abort && left > 0) {
      if (test()) {
        showPause(false);
        return true;
      }
      if (dom.sanction()) return false;
      const hold = paused();
      showPause(hold);
      await sleep(100);
      if (!hold) left -= 100;
    }
    showPause(false);
    return !job.abort && !!test();
  }

  /** La page affiche une sanction : on arrête tout, sans insister. */
  function stopForSanction() {
    stopAll();
    if (pilotOn()) stopPilot(null);
    stopMarketForSanction();
    const message = "Le site affiche une sanction : tout l'automatique est arrêté. Ne relance pas l'enchaînement, regarde tes messages sur le site.";
    log(message);
    note(message, "err");
  }

  /** Une carte L arrive avec une animation (et se révèle shiny à la fin) : on la laisse finir. */
  async function waitCardAnimation(job, card) {
    if (!card || card.rarity !== "L" || !document.getAnimations) return;
    const busy = () => document.getAnimations().some((a) => {
      const t = a.effect && a.effect.target;
      return a.playState === "running" && Number.isFinite(a.effect.getTiming().iterations) &&
        t instanceof Element && (t.contains(card.el) || card.root.contains(t));
    });
    const end = Date.now() + 3000;
    while (!job.abort && Date.now() < end && busy()) await sleep(100);
    await wait(job, 450); // la marque shiny apparaît 350 ms après l'animation
  }

  /** Délai « naturel » : base × rythme (log-normal corrélé) + bonus des cartes au-dessus de SR. */
  function delay(base, card = null) {
    const factor = config.settings.naturalRhythm ? rhythm.factor() : 1;
    return Math.round(base * factor + WMT.rhythm.bonusMs(card));
  }

  async function autoReveal() {
    const job = (autoRun = { abort: false });
    renderAuto();
    try {
      await hold();
    } catch (e) {
      autoRun = null;
      autoStopped = true;
      note(`Défilement impossible : ${e.message}`, "err", null, 15000);
      return renderAuto();
    }
    try {
      for (let step = 0; step < 40 && !job.abort; step++) {
        if (!dom.reveal()) return; // écran fermé
        if (dom.sanction()) return stopForSanction();
        const card = dom.cards(document, knownTags())[0];
        await wait(job, delay(Math.max(100, +config.settings.revealDelay || 200), card));
        await waitCardAnimation(job, card);
        await waitReady(job);
        if (job.abort) return;
        // La carte affichée est analysée avant de passer à la suivante, même en pleine animation.
        const shownCard = dom.cards(document, knownTags())[0];
        if (shownCard) capturePulled(shownCard, true);
        renderPulled(dom.reveal());
        const now = dom.reveal();
        if (!now) return;
        const last = now.index >= now.total;
        // Bouton pas encore prêt (animation, fenêtre du site…) : on patiente au lieu d'abandonner.
        const button = () => {
          const nav = dom.revealNav();
          const b = last ? nav.cont : nav.next;
          return b && !b.disabled ? b : null;
        };
        if (!(await waitActive(job, button, 10000))) {
          if (dom.sanction()) return stopForSanction();
          if (!job.abort) log(last ? "bouton « Continuer » introuvable ou désactivé" : "bouton « suivant » introuvable ou désactivé");
          return;
        }
        if (last) {
          await act.click(button(), "bouton « Continuer »");
          log("« Continuer » cliqué", chain ? `(enchaînement : ${chain.left} paquet(s) à ouvrir)` : "");
          if (chain && !chain.abort) chainNext(chain);
          return;
        }
        await act.click(button(), "bouton « carte suivante »");
        await waitFor(job, () => {
          const r = dom.reveal();
          return !r || r.index !== now.index;
        }, 5000);
        renderAuto();
      }
    } catch (e) {
      if (!job.abort) {
        log("défilement interrompu :", e && e.message);
        note(`Défilement interrompu : ${e && e.message}`, "err", null, 15000);
        if (chain) endChain(chain, null);
      }
    } finally {
      release();
      if (autoRun === job) autoRun = null;
      renderAuto();
    }
  }

  const RETRY_PAUSES = [3000, 8000]; // après un message d'erreur du site (réseau, trop de requêtes…)
  // Message d'erreur qui signale un refus pour automatisation : on n'insiste jamais.
  const REFUSAL = /robot|\bbot\b|script|automati|sanction|bloqu|restreint|suspect|interdit|contr[ôo]le/i;

  /** Après « Continuer » : rouvre un paquet si l'enchaînement en a encore à ouvrir. */
  async function chainNext(job) {
    if (job.left < 1) return endChain(job, `✓ Enchaînement terminé : ${plural(job.total, "paquet")} ouvert${job.total > 1 ? "s" : ""}.`);
    for (let attempt = 0; ; attempt++) {
      // Retour sur la page Paquets, avec un bouton « Ouvrir » de nouveau cliquable. Le chrono
      // s'arrête pendant une vérification ou une fenêtre du site (le bouton peut être grisé).
      const ready = await waitActive(job, () => {
        const b = dom.openButton();
        return !dom.reveal() && b && !b.disabled;
      }, 30000);
      if (job.abort) return;
      if (dom.sanction()) return stopForSanction();
      const live = dom.packs();
      if (live && live.count < 1) return endChain(job, "Plus de paquet disponible : enchaînement terminé.");
      if (!ready) {
        return endChain(job, dom.openButton()
          ? "Le bouton « Ouvrir » est resté désactivé : enchaînement arrêté."
          : "Bouton « Ouvrir » introuvable après « Continuer » : enchaînement arrêté (exporte la page pour que je l'adapte).");
      }
      await wait(job, delay(CHAIN_PAUSE) + (attempt ? RETRY_PAUSES[attempt - 1] : 0));
      await waitReady(job);
      if (job.abort) return;
      const button = dom.openButton();
      if (!button || button.disabled) continue; // regrisé entre-temps : on attend de nouveau
      log(`ouverture du paquet ${job.total - job.left + 1} / ${job.total}` + (attempt ? ` (essai ${attempt + 1})` : ""));
      try {
        await act.click(button, "bouton « Ouvrir »");
      } catch (e) {
        return endChain(job, `Ouverture impossible : ${e.message}.`, true);
      }
      const opened = await waitActive(job, () => !!dom.reveal(), 8000);
      if (job.abort) return;
      if (opened) {
        job.left--; // le défilement prend le relais et rappellera chainNext
        renderAuto();
        return;
      }
      if (dom.sanction()) return stopForSanction();
      const error = dom.packError();
      if (error && REFUSAL.test(error)) return endChain(job, `Le site a refusé l'ouverture (« ${error} ») : enchaînement arrêté.`, true);
      if (error && attempt < RETRY_PAUSES.length) {
        log(`le site n'a pas ouvert le paquet (« ${error} ») : nouvel essai`);
        note(`Le site n'a pas ouvert le paquet (« ${error} ») : nouvel essai dans quelques secondes.`, "warn", null, 10000);
        continue;
      }
      // Aucune réaction (ou erreurs répétées) : on n'insiste pas.
      return endChain(job, "Le site n'a pas ouvert le paquet suivant" + (error ? ` (« ${error} »)` : "") +
        " : enchaînement arrêté. Clique sur « Ouvrir » pour le relancer.", true);
    }
  }

  function endChain(job, message, sticky = false) {
    if (chain === job) chain = null;
    if (job.held) {
      job.held = false;
      release();
    }
    if (message) {
      log(message);
      note(message, message.startsWith("✓") ? "ok" : "warn", null, sticky ? 0 : 15000);
    }
    // Arrêt sur erreur (refus du site, bouton introuvable…) : le pilote s'arrête aussi, pour
    // ne pas recommencer en boucle.
    if (sticky && pilotOn()) stopPilot(null);
    renderAuto();
  }

  /** Enchaînement : par ton appui sur « Ouvrir », ou par le pilote (`auto`). */
  function startChain(auto = false) {
    note(null);
    if (orphaned || !config || !config.settings.autoReveal || !(config.settings.autoChain || auto)) return; // config pas encore chargée
    const live = dom.packs();
    const total = Math.max(1, live ? live.count : 1);
    const job = (chain = { abort: false, left: total - 1, total, held: true });
    hold().catch((e) => endChain(job, `Enchaînement impossible : ${e.message}`, true));
    log(`enchaînement lancé : ${plural(total, "paquet")} disponible${total > 1 ? "s" : ""}`);
    note(null);
    renderAuto();
  }

  function stopAll(message) {
    pauseShown = false;
    if (chain) {
      chain.abort = true;
      endChain(chain, null);
    }
    if (autoRun) {
      autoRun.abort = true;
      autoStopped = true;
    }
    if (message) {
      log(message);
      note(message, "warn", null, 8000);
    }
    renderAuto();
  }

  const onOpenButton = (el) => route === "pulls" && el instanceof Element && dom.isOpenButton(el.closest("button"));
  const fromPanel = (e) => !!ui && e.composedPath().includes(ui.host);

  // Ton appui sur « Ouvrir » (souris, ou Entrée / Espace) (re)lance l'enchaînement. On écoute
  // l'appui en phase de capture : le site peut ouvrir le paquet dès l'appui et remplacer
  // l'écran aussitôt. Le reste de tes clics et touches ne change rien : seul le bouton
  // « Arrêter » du panneau arrête un automatisme (décision du 17/11/2026, nos propres clics
  // étant aussi « isTrusted », act.ours() les écarte).
  document.addEventListener("pointerdown", (e) => {
    if (!e.isTrusted || act.ours() || fromPanel(e)) return;
    if (onOpenButton(e.target)) {
      stopAll();
      startChain();
    }
  }, true);

  document.addEventListener("keydown", (e) => {
    if (!e.isTrusted || act.ours() || fromPanel(e)) return;
    if ((e.key === "Enter" || e.key === " ") && onOpenButton(document.activeElement)) {
      stopAll();
      startChain();
    }
  }, true);

  function renderAuto() {
    if (!ui || !ui.autoStatus) return;
    const r = dom.reveal();
    const parts = [];
    if (chain) parts.push(`Enchaînement : paquet ${chain.total - chain.left} / ${chain.total}`);
    if (autoRun && r) parts.push(`carte ${r.index} / ${r.total}`);
    ui.autoStatus.hidden = !parts.length;
    ui.autoStatus.textContent = parts.join(" · ");
    ui.autoStop.hidden = !(autoRun || chain);
    if (ui.pilotStatus) {
      const on = pilotOn();
      const todo = pilot.pending.length;
      ui.pilotStatus.hidden = !on;
      ui.pilotStatus.textContent = !on ? "" : chain || autoRun ? "Pilote : ouverture en cours." :
        `Pilote actif : en attente d'un paquet${todo ? ` · ${plural(todo, "carte tirée")} à étiqueter` : ""}.`;
      ui.pilotStop.hidden = !on;
    }
  }

  function renderPulled(shown) {
    if (!ui || !ui.pulledList) return;
    const list = [...pulled.values()];
    const todo = list.filter((x) => x.matches.length).length;
    ui.pageCount.textContent = list.length
      ? `${plural(todo, "carte")} à étiqueter sur ${list.length}` + (shown ? ` · carte ${shown.index} / ${shown.total}` : "")
      : "Ouvre un paquet : les cartes tirées s'afficheront ici avec leurs étiquettes suggérées.";
    ui.pulledList.replaceChildren(...list.map(({ card, matches }) => {
      const rarity = h("span", { class: "rar" }, card.rarity || "?");
      rarity.style.background = `var(--color-rarity-${(card.rarity || "c").toLowerCase()}, #b8f2d5)`;
      const tags = matches.length
        ? matches.map((m) => {
            const t = h("span", { class: "tag", title: `Motifs : ${m.hits.join(", ")}` }, m.tag);
            t.style.setProperty("--c", colorOf(m.tag));
            return t;
          })
        : [h("span", { class: "muted" }, core.categoryTags(card, rules).length ? "déjà étiquetée" : "aucune suggestion")];
      return h("div", { class: "pull" }, rarity, h("span", { class: "t" }, card.title), tags);
    }));
    ui.fabN.hidden = !todo;
    ui.fabN.textContent = String(todo);
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 150);
  }

  const isOurs = (n) => n.nodeType === 1 && (n.classList.contains("wmt-flags") || n.id === "wmt-host");

  function onMutations(records) {
    for (const r of records) {
      const target = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      if (target && target.closest(".wmt-flags")) continue;
      const nodes = [...r.addedNodes, ...r.removedNodes];
      if (nodes.length && nodes.every(isOurs)) continue;
      scheduleRefresh();
      return;
    }
  }

  // --- Paquets : relevé du compteur (les rappels sont programmés par background.js) ----

  let packsWriting = false;
  let packsSeen = null; // dernier relevé vu dans CET onglet

  /** Ce qu'un relevé dit du stock : nombre, max, et heure du plein s'il y a un minuteur. */
  function readingKey(live, cooldown, now) {
    const timed = live.nextMs != null;
    const est = packs.estimate({ count: live.count, max: live.max, at: now, nextMs: live.nextMs }, cooldown, now);
    return { count: live.count, max: live.max, timed, fullAt: timed ? est.fullAt : null };
  }

  const sameReading = (a, b) =>
    !!a && a.count === b.count && a.max === b.max && a.timed === b.timed && (!b.timed || Math.abs(a.fullAt - b.fullAt) <= 5000);

  async function updatePacks() {
    const live = dom.packs();
    renderPacks(live);
    // Seul l'onglet affiché enregistre, et seulement ce qu'IL voit changer : un autre onglet resté
    // sur une page Paquets périmée (10/10) ne réécrit plus son ancien relevé à chaque changement
    // du stockage (le compteur oscillait entre 10 et 5).
    if (!live || packsWriting || document.visibilityState !== "visible") return;
    const now = Date.now();
    const cooldown = packs.cooldownMs(config.settings);
    const seen = readingKey(live, cooldown, now);
    if (sameReading(packsSeen, seen)) return;
    packsSeen = seen;
    const before = packs.estimate(packsState, cooldown, now);
    let next = null;
    if (live.nextMs != null) {
      // Minuteur affiché : relevé exact, réécrit seulement si la prévision bouge vraiment.
      const cand = { count: live.count, max: live.max, at: now, nextMs: live.nextMs };
      const after = packs.estimate(cand, cooldown, now);
      if (!before || after.count !== before.count || after.max !== before.max || Math.abs(after.fullAt - before.fullAt) > 5000) next = cand;
    } else if (!before || before.count !== live.count || before.max !== live.max) {
      next = { count: live.count, max: live.max, at: now, nextMs: null };
    }
    if (!next) return;
    packsState = next;
    packsWriting = true;
    await safe(() => store.set("packs", next));
    packsWriting = false;
    renderPacks(live);
  }

  function renderPacks(live = dom.packs()) {
    if (!ui || !ui.packCount) return;
    const s = config.settings;
    const est = packs.estimate(packsState, packs.cooldownMs(s));
    const count = live ? live.count : est && est.count;
    const max = live ? live.max : est && est.max;
    if (live) ui.packCount.textContent = `${count} / ${max} paquets disponibles`;
    else if (est) ui.packCount.textContent = `≈ ${count} / ${max} paquets disponibles (estimation)`;
    else ui.packCount.textContent = "Compteur pas encore relevé.";
    const plan = s.accountType === "pro" ? "Pro, 1 paquet / 3 min" : "gratuit, 1 paquet / 10 min";
    ui.packInfo.textContent = est ? `${packs.describe(est)} · compte ${plan}` : `Compte ${plan}.`;
    ui.packNotif.textContent = s.notifyFull ? "Notification quand c'est plein." : "Aucun rappel activé.";
    ui.fabLabel.textContent = count != null ? `Tagger · ${count}/${max}` : "Tagger";
  }

  // --- Pilote automatique (décidé le 17/11/2026) ------------------------------------------
  // Activé dans le panneau des Paquets (« Ouvrir les paquets dès qu'ils arrivent »), sous ta
  // supervision : dès qu'un paquet est disponible, l'extension l'ouvre elle-même, fait défiler
  // les cartes et enchaîne tant qu'il en reste. Une fois le stock vide, si « Puis étiqueter les
  // cartes tirées » est coché, elle va sur la Collection (sans filtre, tri « Date d'ajout » :
  // les cartes tirées sont en tête), y pose les étiquettes suggérées pour ces cartes, puis
  // revient attendre le paquet suivant. Pas de filtre « Sans étiquette » : une carte qui a deux
  // étiquettes à poser en disparaîtrait dès la première. Le pilote garde l'onglet actif même caché (lib/driver.js).
  // Il s'arrête par « Arrêter le pilote », et pour de bon sur une sanction ou un refus du site
  // (le réglage est alors coupé). Les cartes à étiqueter sont gardées dans le stockage (clé
  // pilot) : après un rechargement de la page, le pilote reprend où il en était.

  let pilot = { pending: [] }; // {pending: titres des cartes tirées à étiqueter}
  let pilotBusy = false;
  let pilotTimer = 0;
  let pilotHeld = false;
  let pilotAlerted = "";
  const PILOT_EVERY = 3000; // ms entre deux vérifications du stock (l'onglet reste actif)
  const PILOT_PAGES = 3; // pages lues au plus pour retrouver les cartes tirées (tri par date)

  const pilotOn = () => !!(config && config.settings.autoOpen) && !orphaned;

  // Un seul onglet pilote : deux onglets sur la page Paquets ouvriraient chacun des paquets.
  // Verrou {id, at} dans le stockage, renouvelé à chaque vérification, libre après 15 s.
  const PILOT_ID = Math.random().toString(36).slice(2);
  const PILOT_LOCK_MS = 15000;
  let pilotLock = null;
  store.get("pilotLock").then((v) => (pilotLock = v || null), () => {});
  store.onChange((ch) => {
    if (ch.pilotLock) pilotLock = ch.pilotLock.newValue || null;
  });
  async function pilotClaim() {
    const now = Date.now();
    if (pilotLock && pilotLock.id !== PILOT_ID && now - pilotLock.at < PILOT_LOCK_MS) return false;
    pilotLock = { id: PILOT_ID, at: now };
    await safe(() => store.set("pilotLock", pilotLock));
    return true;
  }

  /** Retient une carte tirée qui a des étiquettes à poser. */
  function pilotRemember(card, matches) {
    if (!pilotOn() || !config.settings.autoTagPulled || !matches.length) return;
    if (pilot.pending.includes(card.title)) return;
    pilot = { ...pilot, pending: [...pilot.pending, card.title] };
    safe(() => store.set("pilot", pilot));
  }

  /** Notification Chrome (onglet caché) : une seule fois par message. */
  function pilotAlert(text) {
    if (pilotAlerted === text) return;
    pilotAlerted = text;
    safe(() => chrome.runtime.sendMessage({ type: "pilotAlert", text }));
  }

  /** Démarre le pilote sur la page affichée : onglet actif, vérification régulière du stock. */
  function startPilot() {
    if (!pilotOn() || route !== "pulls" || pilotTimer) return;
    if (!pilotHeld) {
      pilotHeld = true;
      hold().catch((e) => stopPilot(`Pilote arrêté : ${e.message}`));
    }
    pilotTimer = setInterval(pilotTick, PILOT_EVERY);
    log("pilote actif");
    pilotTick();
  }

  /** Suspend le pilote sur cette page (changement de page) sans couper le réglage. */
  function pausePilot() {
    clearInterval(pilotTimer);
    pilotTimer = 0;
    if (pilotHeld) {
      pilotHeld = false;
      release();
    }
  }

  /** Coupe le pilote (réglage désactivé). */
  function stopPilot(message) {
    pausePilot();
    if (config && config.settings.autoOpen) setSetting("autoOpen", false);
    if (message) {
      log(message);
      note(message, "warn", null, 0);
      pilotAlert(message);
    }
    renderAuto();
  }

  /** Va sur `path` par le lien du site (navigation interne), sinon par l'adresse. */
  async function pilotGo(path) {
    log(`pilote : vers ${path}`);
    await hold();
    try {
      const link = dom.navLink(path);
      if (link) await act.click(link, `lien « ${path} »`);
      else location.assign(path);
      await waitFor({ abort: false }, () => location.pathname.replace(/\/+$/, "") === path, 10000);
    } finally {
      release();
    }
  }

  /** Une vérification du pilote sur la page Paquets. */
  async function pilotTick() {
    if (!pilotOn() || route !== "pulls" || pilotBusy || chain || autoRun || dom.reveal()) return;
    if (dom.sanction()) return stopForSanction();
    if (dom.blockingDialog()) return; // vérification, annonce : on attend qu'elle disparaisse
    const live = dom.packs();
    if (!live) return;
    pilotBusy = true;
    try {
      if (!(await pilotClaim())) return; // un autre onglet pilote déjà
      if (live.count < 1) {
        if (config.settings.autoTagPulled && pilot.pending.length) await pilotGo("/collection");
        return;
      }
      const b = dom.openButton();
      if (!b || b.disabled) return;
      if (dom.packError() && REFUSAL.test(dom.packError())) return stopPilot(`Le site refuse l'ouverture (« ${dom.packError()} ») : pilote arrêté.`);
      startChain(true);
      if (!chain) return;
      log(`pilote : ouverture (${plural(live.count, "paquet")} disponible${live.count > 1 ? "s" : ""})`);
      await act.click(b, "bouton « Ouvrir »");
      // Le défilement prend le relais (refreshPulls → autoReveal → chainNext).
    } catch (e) {
      stopPilot(`Pilote arrêté : ${e.message}`);
    } finally {
      pilotBusy = false;
      renderAuto();
    }
  }

  /** Étiquetage des cartes tirées, sur la Collection, puis retour aux Paquets. */
  async function runPilotTag() {
    if (scanning || tagging || selling || route !== "collection") return;
    const job = (tagging = { abort: false, pilot: true });
    const stats = { applied: 0, pages: 0, failed: 0, byTag: new Map(), skipped: new Map() };
    const missing = new Set();
    const pending = new Set(pilot.pending);
    const total = pending.size;
    const sortBefore = dom.sortButton() ? dom.clean(dom.sortButton().textContent) : "";
    let held = false;
    let done = false;
    note(null);
    renderPanel();
    ui.progress.hidden = false;
    try {
      await hold();
      held = true;
      await leaveSelection();
      await waitIdle(job);
      ui.ptext.textContent = `Pilote : ${plural(total, "carte tirée")} à étiqueter…`;
      await setTagFilter(job, "Toutes les étiquettes");
      await setRarityFilter(job, new Set());
      await setSort(job, "Date d'ajout");
      let p = pageInfo();
      if (p.page !== 1) p = await goToPage(job, 1, "Retour au début");
      for (let guard = 0; pending.size && guard < 40; guard++) {
        await waitIdle(job);
        p = pageInfo();
        const here = dom.cards(document, knownTags()).filter((c) => pending.has(c.title));
        if (!here.length) {
          // Les cartes les plus récentes sont en tête : inutile d'aller plus loin.
          if (p.page >= PILOT_PAGES || !(await hasNextPage(job))) break;
          p = await turnPage(job, 1);
          continue;
        }
        const plan = new Map();
        for (const c of here) {
          pending.delete(c.title);
          for (const m of suggestionsFor(c)) {
            if (!plan.has(m.tag)) plan.set(m.tag, []);
            plan.get(m.tag).push({ pos: c.pos, title: c.title });
          }
        }
        for (const [tag, items] of plan) {
          ui.ptext.textContent = `Pilote : ${tag} (${plural(items.length, "carte")}) · ${plural(stats.applied, "étiquette")} posées`;
          if (missing.has(tag) || !(await applyTag(job, tag, items, stats))) {
            missing.add(tag);
            stats.skipped.set(tag, (stats.skipped.get(tag) || 0) + items.length);
          }
          await step(job, 250);
        }
        stats.pages++;
      }
      done = true;
      const lost = pending.size ? ` ${plural(pending.size, "carte tirée")} introuvable${pending.size > 1 ? "s" : ""} parmi les ${PILOT_PAGES * 50} cartes les plus récentes.` : "";
      log("pilote : étiquetage terminé :", tagSummary(stats) + lost);
      note(`✓ Pilote : ${tagSummary(stats)}${lost}`, "ok", null, 30000);
    } catch (e) {
      log("pilote : étiquetage interrompu :", e && e.message);
      if (e instanceof Aborted) note(`Étiquetage du pilote arrêté. ${tagSummary(stats)}`, "warn");
      else stopPilot(`Étiquetage du pilote interrompu : ${e.message} ${tagSummary(stats)}`);
    } finally {
      await leaveSelection();
      const reset = { abort: false };
      try {
        if (sortBefore && sortBefore !== "Date d'ajout") await setSort(reset, sortBefore);
      } catch (e) {
        log("filtres non remis comme avant :", e.message);
      }
      if (done) {
        pilot = { ...pilot, pending: [] };
        await safe(() => store.set("pilot", pilot));
      }
      if (held) release();
      tagging = null;
      if (ui) {
        ui.progress.hidden = true;
        renderPanel();
      }
      refresh();
      if (done && !job.abort && pilotOn()) {
        await pilotGo("/pulls").catch((e) => stopPilot(`Pilote arrêté : ${e.message}`));
      }
    }
  }

  // --- Pilotage de la page Collection --------------------------------------------------
  // Toute action qui change la liste (page, filtre, étiquette posée, défausse) la recharge,
  // après un court délai sans aucun signe (voir dom.collectionLoading). Règle unique : on ne
  // lit et on ne clique qu'une collection au repos, et chaque action attend la fin du
  // rechargement qu'elle a déclenché (reloadAfter). Lire pendant ce délai donnait des cartes
  // périmées, cliquer pendant le chargement des boutons désactivés.

  const CLICK_PAUSE = 140; // ms entre deux clics, × rythme naturel
  const signature = () => dom.cardElements().map((c) => c.h3.textContent).join("\u0001");

  async function waitVisible(job) {
    while (!job.abort && document.hidden) await sleep(300);
    if (job.abort) throw new Aborted();
  }

  async function step(job, base = CLICK_PAUSE) {
    await wait(job, delay(base));
    await waitVisible(job);
  }

  async function until(job, test, ms, what) {
    if (await waitFor(job, test, ms)) return;
    if (job.abort) throw new Aborted();
    throw new Error(what);
  }

  /** Attend que la collection ne soit plus en train de se recharger. */
  async function waitIdle(job) {
    await until(job, () => !dom.collectionLoading(), 45000, "la collection est restée en chargement plus de 45 s.");
  }

  /**
   * Lance `action` (un clic qui recharge la liste) puis attend la fin du rechargement qu'elle
   * provoque. Le début est guetté par un MutationObserver, qui le voit même s'il est très
   * bref ; la fin, quand plus rien n'indique un chargement. `failed()` arrête l'attente si le
   * site affiche une erreur au lieu de recharger : renvoie alors false.
   */
  async function reloadAfter(job, action, what, failed = () => false) {
    await waitIdle(job);
    let seen = false;
    const watch = new MutationObserver(() => {
      if (!seen && dom.collectionLoading()) seen = true;
    });
    watch.observe(document.body, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "disabled"],
    });
    try {
      await action();
      await until(job, () => seen || dom.collectionLoading() || failed(), 20000, `${what} : le site n'a pas rechargé la collection.`);
      if (!seen && !dom.collectionLoading()) return false; // erreur affichée par le site
      await waitIdle(job);
    } finally {
      watch.disconnect();
    }
    await sleep(150); // dernier rendu des cartes
    return true;
  }

  /**
   * Page affichée (collection au repos) : {page, total, prev, next}. Le site n'affiche pas de
   * pagination quand tout tient sur une page. Sans pagination ni « Sélectionner », c'est que le
   * total de la collection n'a pas été chargé (erreur du site) : on ne devine pas.
   */
  function pageInfo() {
    const p = dom.pager();
    if (p) return p;
    if (dom.cardElements().length && !dom.selectButton() && !dom.quitSelectionButton()) {
      throw new Error("le site n'a pas chargé le total de ta collection (ni pagination ni « Sélectionner ») : recharge la page (F5).");
    }
    return { page: 1, total: 1, prev: null, next: null };
  }

  // Le total de pages vient d'une requête séparée, qui arrive parfois quelques secondes après
  // les cartes : juste après un rechargement de la page 1, « Page X / Y » et l'état de
  // « Suivant » peuvent être périmés. Pour savoir s'il reste une page, on se fie d'abord au
  // nombre de cartes (le site en affiche 50 par page), puis à « Suivant », en lui laissant le
  // temps de s'activer.
  const PAGE_SIZE = 50;

  const navButton = (dir) => {
    const p = dom.pager();
    const b = p && (dir > 0 ? p.next : p.prev);
    return b && !b.disabled ? b : null;
  };

  /** Reste-t-il une page après celle affichée ? */
  async function hasNextPage(job) {
    await waitIdle(job);
    if (dom.cardElements().length < PAGE_SIZE) return false; // page incomplète : la dernière
    return waitFor(job, () => !!navButton(1), 10000);
  }

  /** Page précédente (-1) ou suivante (+1) ; attend que la nouvelle page soit chargée. */
  async function turnPage(job, dir) {
    await waitIdle(job);
    const p = pageInfo();
    const target = p.page + dir;
    await waitFor(job, () => !!navButton(dir), 10000);
    if (job.abort) throw new Aborted();
    const button = navButton(dir);
    if (!button) {
      throw new Error(`impossible d'aller à la page ${target} : bouton « ${dir > 0 ? "Suivant" : "Précédent"} » indisponible (page ${p.page} / ${p.total}).`);
    }
    await wait(job, Math.max(300, +config.settings.pageDelay || 1000));
    if (job.abort) throw new Aborted();
    await reloadAfter(job, () => act.click(button, `bouton « ${dir > 0 ? "Suivant" : "Précédent"} »`), `Page ${target}`);
    const now = pageInfo();
    if (now.page !== target) throw new Error(`la page ${target} ne s'est pas affichée (page ${now.page} à la place).`);
    return now;
  }

  /**
   * Saute directement à la page `target` avec « Page X / Y » → champ « Aller à la page » →
   * Entrée. Renvoie la page affichée, ou null si le saut n'est pas possible.
   */
  async function jumpToPage(job, target) {
    await waitIdle(job);
    const p = pageInfo();
    if (!p.jump || target > p.total) return null;
    await act.click(p.jump, "bouton « Page X / Y »");
    if (!(await waitFor(job, () => !!dom.pageInput(), 3000))) {
      if (job.abort) throw new Aborted();
      return null;
    }
    await step(job);
    await act.type(dom.pageInput(), target, "champ « Aller à la page »");
    await step(job);
    await reloadAfter(job, () => act.key("Enter"), `Page ${target}`);
    return pageInfo();
  }

  /**
   * Va à la page `target` : saut direct si le site le propose, sinon une page à la fois
   * (« Précédent » / « Suivant »).
   */
  async function goToPage(job, target, label) {
    let p = pageInfo();
    target = Math.max(1, target); // pas de plafond : le total affiché peut être périmé
    if (p.page !== target && Math.abs(p.page - target) > 1) {
      ui.ptext.textContent = `${label} : page ${p.page} → ${target}`;
      const jumped = await jumpToPage(job, target);
      if (jumped) p = jumped;
      if (p.page !== target) log(`saut à la page ${target} sans effet (page ${p.page}) : page par page`);
    }
    while (p.page !== target) {
      ui.ptext.textContent = `${label} : page ${p.page} → ${target}`;
      p = await turnPage(job, target > p.page ? 1 : -1);
    }
    return p;
  }

  async function enterSelection(job) {
    if (dom.quitSelectionButton()) return;
    await waitIdle(job);
    const b = dom.selectButton();
    if (!b) throw new Error("bouton « Sélectionner » introuvable : recharge la page (F5).");
    await act.click(b, "bouton « Sélectionner »");
    await until(job, () => !!dom.quitSelectionButton(), 5000, "le mode sélection ne s'est pas activé.");
  }

  /** Annule une confirmation, ferme la fenêtre d'étiquetage et quitte le mode sélection (aussi après un arrêt). */
  async function leaveSelection() {
    const job = { abort: false };
    const warn = (e) => log("nettoyage :", e.message);
    const dialog = dom.discardDialog();
    if (dialog && dialog.cancel) {
      await act.click(dialog.cancel, "bouton « Annuler »").catch(warn); // jamais « Défausser » ici : on annule
      await waitFor(job, () => !dom.discardDialog(), 3000);
    }
    const modal = dom.tagModal();
    const close = modal && (modal.done || modal.close);
    if (close) {
      await act.click(close, "fermeture de la fenêtre d'étiquetage").catch(warn);
      await waitFor(job, () => !dom.tagModal(), 3000);
    }
    const quit = dom.quitSelectionButton();
    if (quit) {
      await act.click(quit, "bouton « Quitter la sélection »").catch(warn);
      await waitFor(job, () => !!dom.selectButton(), 5000);
    }
  }

  /** Carte de la page affichée pour un élément d'un plan (même position, sinon même titre). */
  function findCard(item) {
    const cards = dom.cards(document, knownTags());
    const at = cards[item.pos - 1];
    return at && at.title === item.title ? at : cards.find((c) => c.title === item.title) || null;
  }

  // --- Analyse de toutes les pages de la collection ----------------------------------

  async function runScan(ignoreFilters = false) {
    if (scanning || tagging || selling || route !== "collection") return;
    const filters = dom.activeFilters();
    if (filters.length && !ignoreFilters) {
      setOpen(true);
      note(`Filtre actif (${filters.join(", ")}) : l'analyse ne verrait qu'une partie de ta collection.`, "warn", {
        label: "Analyser quand même",
        onclick: () => runScan(true),
      });
      return;
    }
    ui.prompt.hidden = true;
    const job = (scanning = { abort: false });
    const pages = new Map();
    const colors = {};
    note(null);
    renderPanel();
    let held = false;
    try {
      await hold();
      held = true;
      await waitIdle(job);
      let p = pageInfo();
      const grab = () => {
        const cards = dom.cards(document, knownTags());
        cards.forEach((c) => Object.assign(colors, c.colors));
        pages.set(p.page, cards.map(({ root, el, h3, colors: _, ...c }) => ({ ...c, page: p.page })));
        progress(p, pages);
      };
      grab();
      // Retour à la page 1 (en lisant au passage), puis lecture jusqu'à la dernière page.
      while (p.page > 1) {
        p = await turnPage(job, -1);
        if (!pages.has(p.page)) grab();
      }
      while (await hasNextPage(job)) {
        p = await turnPage(job, 1);
        if (!pages.has(p.page)) grab();
      }
      const last = p.page;
      const missing = Array.from({ length: last }, (_, i) => i + 1).filter((n) => !pages.has(n));
      if (missing.length) throw new Error(`Pages non lues : ${missing.join(", ")}.`);

      const cards = [...pages.keys()].sort((a, b) => a - b).flatMap((n) => pages.get(n));
      const meta = { at: Date.now(), n: cards.length, pages: last };
      await safe(() => store.set("scan", { at: meta.at, pages: last, cards }));
      await safe(() => store.set("scanMeta", meta));
      scanMeta = meta;
      syncColors(colors);
      note(`✓ ${plural(cards.length, "carte")} lues sur ${plural(last, "page")}. Tu peux lancer la catégorisation.`, "ok");
      ui.homeBtn.hidden = false;
    } catch (e) {
      if (e instanceof Aborted) note("Analyse arrêtée.", "warn");
      else note(`Analyse interrompue : ${e.message}`, "err");
    } finally {
      if (held) release();
      scanning = null;
      if (ui) {
        ui.progress.hidden = true;
        renderPanel();
      }
    }
  }

  // --- Étiquetage automatique de toute la collection --------------------------------
  // Page par page : pour chaque étiquette suggérée qui existe dans le jeu, mode sélection,
  // clic sur ses cartes, « Étiqueter », clic sur l'étiquette (le site la pose et recharge la
  // liste), « Terminé », sortie du mode sélection. Les étiquettes absentes du jeu ne sont
  // jamais créées : elles sont sautées. Arrêt dès que tu cliques ou tapes hors du panneau.
  // Chaque page terminée est notée (clé tagRun) : relancé, l'étiquetage reprend là où il
  // s'était arrêté, au lieu de revenir page par page jusqu'à la première.

  let tagging = null; // {abort}
  let tagResume = null; // {next, total, at} : prochaine page à étiqueter
  const RESUME_MS = 24 * 3600 * 1000;

  /** Page de reprise valable pour une collection de `total` pages, sinon null. */
  function resumePage(total) {
    const r = tagResume;
    return r && Date.now() - r.at < RESUME_MS && r.total === total && r.next > 1 && r.next <= total ? r.next : null;
  }

  /** Pose `tag` sur les cartes `items` de la page affichée. Renvoie false si l'étiquette n'existe pas. */
  async function applyTag(job, tag, items, stats) {
    await enterSelection(job);
    let clicked = 0;
    for (const item of items) {
      const card = findCard(item);
      if (!card) continue;
      await act.click(card.h3, `carte « ${item.title} »`);
      clicked++;
      await step(job);
    }
    // Une carte avec un échange en attente n'est pas sélectionnable : on prend ce qui l'est.
    await waitFor(job, () => {
      const bar = dom.selectionBar();
      return bar && !bar.refreshing && bar.count === clicked && !bar.tag.disabled;
    }, 5000);
    if (job.abort) throw new Aborted();
    const bar = dom.selectionBar();
    if (!bar || bar.refreshing || !bar.count || bar.tag.disabled) {
      log(`« ${tag} » : aucune des ${plural(items.length, "carte")} n'a pu être sélectionnée`);
      stats.failed += items.length;
      await leaveSelection();
      return true;
    }
    const selected = bar.count;
    await act.click(bar.tag, "bouton « Étiqueter »");
    await until(job, () => {
      const m = dom.tagModal();
      return m && !m.loading && m.tags.size > 0;
    }, 10000, "la fenêtre « Appliquer une étiquette » ne s'est pas ouverte.");
    const button = dom.tagModal().tags.get(tag);
    if (!button) {
      await leaveSelection();
      return false;
    }
    await step(job);
    // Le clic pose l'étiquette, affiche « N cartes étiquetées » et recharge la collection.
    const posed = await reloadAfter(job, () => act.click(button, `étiquette « ${tag} »`), `« ${tag} »`, () => !!(dom.tagModal() && dom.tagModal().error));
    const m = dom.tagModal();
    if (!posed || (m && m.error)) throw new Error(`le site n'a pas posé « ${tag} »${m && m.error ? ` : ${m.error}` : ""}.`);
    stats.applied += m && m.added != null ? m.added : selected;
    stats.byTag.set(tag, (stats.byTag.get(tag) || 0) + selected);
    await leaveSelection();
    return true;
  }

  async function tagPage(job, p, stats, missing) {
    await waitIdle(job);
    const plan = new Map(); // étiquette -> [{pos, title}], calculé avant toute pose
    for (const c of dom.cards(document, knownTags())) {
      for (const m of suggestionsFor(c)) {
        if (!plan.has(m.tag)) plan.set(m.tag, []);
        plan.get(m.tag).push({ pos: c.pos, title: c.title });
      }
    }
    for (const [tag, items] of plan) {
      ui.ptext.textContent = `Page ${p.page} / ${p.total} · ${tag} (${plural(items.length, "carte")}) · ${plural(stats.applied, "étiquette")} posées`;
      if (missing.has(tag) || !(await applyTag(job, tag, items, stats))) {
        missing.add(tag);
        stats.skipped.set(tag, (stats.skipped.get(tag) || 0) + items.length);
      }
      await step(job, 250);
    }
    stats.pages++;
  }

  function tagSummary(stats) {
    const done = [...stats.byTag].map(([t, n]) => `${t} ${n}`).join(", ");
    const skipped = [...stats.skipped].map(([t, n]) => `${t} (${n})`).join(", ");
    return `${plural(stats.applied, "étiquette")} posée${stats.applied > 1 ? "s" : ""} sur ${plural(stats.pages, "page")}` +
      (done ? ` : ${done}.` : ".") +
      (skipped ? ` Sautées car absentes du jeu : ${skipped}.` : "") +
      (stats.failed ? ` ${plural(stats.failed, "carte")} non sélectionnable${stats.failed > 1 ? "s" : ""}.` : "");
  }

  function stopTagging() {
    if (!tagging || tagging.abort) return;
    tagging.abort = true;
    if (tagging.pilot) stopPilot("Pilote arrêté.");
    log("étiquetage arrêté depuis le panneau");
  }

  async function runAutoTag(ignoreFilters = false, fromStart = false) {
    if (scanning || tagging || selling || route !== "collection") return;
    const filters = dom.activeFilters();
    if (filters.length && !ignoreFilters) {
      setOpen(true);
      note(`Filtre actif (${filters.join(", ")}) : seules les cartes filtrées seraient étiquetées.`, "warn", {
        label: "Étiqueter quand même",
        onclick: () => runAutoTag(true, fromStart),
      });
      return;
    }
    const job = (tagging = { abort: false });
    const stats = { applied: 0, pages: 0, failed: 0, byTag: new Map(), skipped: new Map() };
    const missing = new Set();
    note(null);
    renderPanel();
    ui.progress.hidden = false;
    let held = false;
    try {
      await hold();
      held = true;
      await leaveSelection();
      await waitIdle(job);
      let p = pageInfo();
      const resume = fromStart ? null : resumePage(p.total);
      if (!fromStart && !resume && tagResume) log("reprise impossible : le nombre de pages a changé depuis l'interruption, départ de la page 1");
      if (p.page !== (resume || 1)) p = await goToPage(job, resume || 1, resume ? "Reprise" : "Retour au début");
      for (;;) {
        ui.bar.style.width = `${Math.round((100 * (p.page - 1)) / p.total)}%`;
        await tagPage(job, p, stats, missing);
        await safe(() => store.set("tagRun", { next: p.page + 1, total: p.total, at: Date.now() }));
        if (!(await hasNextPage(job))) break;
        p = await turnPage(job, 1);
      }
      await safe(() => store.remove("tagRun"));
      log("étiquetage terminé :", tagSummary(stats));
      note(`✓ ${tagSummary(stats)}`, "ok");
    } catch (e) {
      log("étiquetage interrompu :", e && e.message);
      if (e instanceof Aborted) note(`Étiquetage arrêté. ${tagSummary(stats)}`, "warn");
      else note(`Étiquetage interrompu : ${e.message} ${tagSummary(stats)}`, "err");
    } finally {
      await leaveSelection();
      if (held) release();
      tagging = null;
      if (ui) {
        ui.progress.hidden = true;
        renderPanel();
      }
      refresh();
    }
  }

  // --- Vente (défausse) des cartes sans étiquette -----------------------------------
  // Filtres du site « Sans étiquette » + raretés choisies dans le panneau (un clic à la fois,
  // chacun suivi de son rechargement), puis tant qu'il reste des cartes : page sélectionnée
  // avec « Tout sélectionner (page) », favoris et cartes shiny désélectionnés (si « Garder »),
  // « Défausser (+N) », confirmation du site après vérification du nombre. Les cartes vendues
  // disparaissent : les suivantes remontent sur la même page. Avant chaque vente, chaque carte
  // affichée est vérifiée (sans étiquette, bonne rareté) : au moindre écart, rien n'est vendu.

  let selling = null; // {abort}
  const RARITY_ORDER = ["L", "UR", "SR", "R", "PC", "C"];

  /** Choisit `label` dans une liste déroulante du site (même composant pour le filtre et le tri). */
  async function setListChoice(job, button, label, what) {
    await waitIdle(job);
    const b = button();
    if (!b) throw new Error(`${what} introuvable.`);
    if (dom.clean(b.textContent) === label) return;
    await act.click(b, what);
    await until(job, () => dom.tagFilterOptions().has(label), 5000, `option « ${label} » introuvable (${what}).`);
    await step(job);
    const option = dom.tagFilterOptions().get(label);
    await reloadAfter(job, () => act.click(option, `option « ${label} »`), `${what} « ${label} »`);
    if (dom.clean(button().textContent) !== label) throw new Error(`${what} « ${label} » ne s'est pas appliqué.`);
  }

  const setTagFilter = (job, label) => setListChoice(job, dom.tagFilterButton, label, "filtre d'étiquette");
  const setSort = (job, label) => setListChoice(job, dom.sortButton, label, "tri");

  async function setRarityFilter(job, wanted) {
    for (const r of RARITY_ORDER) {
      const chip = dom.rarityChips().get(r);
      if (!chip || chip.on === wanted.has(r)) continue;
      await reloadAfter(job, () => act.click(chip.button, `filtre de rareté ${r}`), `Filtre de rareté ${r}`);
      if (dom.rarityChips().get(r).on !== wanted.has(r)) throw new Error(`le filtre de rareté ${r} ne s'est pas appliqué.`);
    }
  }

  async function sellPage(job, sell, kept, stats) {
    await enterSelection(job);
    const first = findCard(sell[0]);
    if (!first) throw new Error("carte introuvable après le passage en mode sélection.");
    await act.click(first.h3, `carte « ${sell[0].title} »`);
    await until(job, () => !!dom.selectionBar(), 5000, "barre de sélection introuvable.");
    await step(job);
    const all = dom.barButton(dom.selectionBar(), /^Tout sélectionner/);
    if (all) {
      await act.click(all, "bouton « Tout sélectionner (page) »");
      await step(job, 300);
    }
    for (const c of kept) {
      if (dom.pendingTrade(c)) continue; // déjà exclue par le site
      const cur = findCard(c);
      if (cur) {
        await act.click(cur.h3, `carte « ${c.title} »`);
        await step(job);
      }
    }
    await until(job, () => {
      const bar = dom.selectionBar();
      return bar && !bar.refreshing && bar.count === sell.length;
    }, 5000, `sélection incohérente (${(dom.selectionBar() || {}).count} cartes au lieu de ${sell.length}) : rien n'a été vendu.`);
    const discard = dom.barButton(dom.selectionBar(), /^Défausser \(\+\d+\)$/);
    if (!discard || discard.disabled) throw new Error("bouton « Défausser » introuvable.");
    // Le site retire lui-même du compte les cartes verrouillées (favoris, échange en attente).
    const offered = +dom.clean(discard.textContent).match(/\+(\d+)/)[1];
    if (offered !== sell.length) {
      throw new Error(`le site défausserait ${offered} cartes au lieu de ${sell.length} (carte verrouillée non reconnue ?) : rien n'a été vendu.`);
    }
    await act.click(discard, "bouton « Défausser »");
    await until(job, () => !!dom.discardDialog(), 5000, "confirmation de défausse introuvable.");
    const dialog = dom.discardDialog();
    if (dialog.count !== sell.length || !dialog.confirm) {
      if (dialog.cancel) await act.click(dialog.cancel, "bouton « Annuler »").catch(() => {});
      throw new Error(`le site propose de défausser ${dialog.count} cartes au lieu de ${sell.length} : annulé.`);
    }
    await step(job, 300);
    if (job.abort) throw new Aborted(); // dernier moment pour s'arrêter avant la vente
    // La confirmation défausse les cartes, ferme la fenêtre et recharge la collection.
    const sold = await reloadAfter(job, () => act.click(dialog.confirm, "confirmation « Défausser »"), "Défausse", () => !!(dom.discardDialog() && dom.discardDialog().error));
    if (!sold) {
      const refused = dom.discardDialog();
      if (refused && refused.cancel) await act.click(refused.cancel, "bouton « Annuler »").catch(() => {});
      throw new Error(`le site a refusé la défausse : ${(refused && refused.error) || "pas de réponse"}.`);
    }
    const n = dom.discardedMessage();
    stats.sold += n != null ? n : sell.length;
    log(`${plural(sell.length, "carte")} vendue${sell.length > 1 ? "s" : ""} :`, sell.map((c) => c.title).join(", "));
    await leaveSelection();
  }

  function sellSummary(stats) {
    return `${plural(stats.sold, "carte")} vendue${stats.sold > 1 ? "s" : ""} (+${stats.sold} wikibidou${stats.sold > 1 ? "s" : ""})` +
      (stats.kept.size ? `, ${plural(stats.kept.size, "carte")} gardée${stats.kept.size > 1 ? "s" : ""} (favoris, shiny ou échange en cours).` : ".");
  }

  function askSell() {
    const rarities = RARITY_ORDER.filter((r) => (config.settings.sellRarities || []).includes(r));
    if (!rarities.length) return note("Choisis d'abord au moins une rareté.", "warn", null, 6000);
    note(`Vendre toutes tes cartes sans étiquette de rareté ${rarities.join(", ")} ? Irréversible : chaque carte est retirée ` +
      `contre 1 wikibidou. Favoris gardés (le site les verrouille)${config.settings.sellKeep !== false ? ", cartes shiny aussi" : ""}.`, "err",
    { label: "Oui, vendre ces cartes", onclick: () => runSell() });
  }

  function stopSelling() {
    if (!selling || selling.abort) return;
    selling.abort = true;
    log("vente arrêtée depuis le panneau");
  }

  async function runSell() {
    if (scanning || tagging || selling || route !== "collection") return;
    const rarities = new Set(config.settings.sellRarities || []);
    if (!rarities.size) return askSell();
    const keep = config.settings.sellKeep !== false;
    const job = (selling = { abort: false });
    const stats = { sold: 0, kept: new Set() };
    note(null);
    renderPanel();
    ui.progress.hidden = false;
    ui.bar.style.width = "0%";
    let held = false;
    try {
      await hold();
      held = true;
      await leaveSelection();
      ui.ptext.textContent = "Filtres « Sans étiquette » et raretés…";
      await setTagFilter(job, "Sans étiquette");
      await setRarityFilter(job, rarities);
      let p = pageInfo();
      if (p.page !== 1) p = await goToPage(job, 1, "Retour au début");
      for (let round = 0; round < 1000; round++) {
        await waitIdle(job);
        p = pageInfo();
        const cards = dom.cards(document, knownTags());
        if (!cards.length || dom.emptyResult()) break;
        const wrong = cards.find((c) => c.tags.length || !rarities.has(c.rarity));
        if (wrong) {
          throw new Error(`carte inattendue malgré les filtres : « ${wrong.title} » ${wrong.tags.length ? "a une étiquette" : `est ${wrong.rarity}`}. Rien n'a été vendu sur cette page.`);
        }
        // Favoris et échanges en attente : verrouillés par le site, jamais défaussables.
        const kept = cards.filter((c) => dom.isStarred(c) || dom.pendingTrade(c) || (keep && c.shiny));
        kept.forEach((c) => stats.kept.add(c.title));
        const sell = cards.filter((c) => !kept.includes(c));
        ui.ptext.textContent = `Page ${p.page} / ${p.total} · ${plural(stats.sold, "carte")} vendue${stats.sold > 1 ? "s" : ""}`;
        if (!sell.length) {
          if (await hasNextPage(job)) {
            p = await turnPage(job, 1);
            continue;
          }
          break;
        }
        await sellPage(job, sell, kept, stats);
      }
      log("vente terminée :", sellSummary(stats));
      note(`✓ ${sellSummary(stats)}`, "ok");
    } catch (e) {
      log("vente interrompue :", e && e.message);
      if (e instanceof Aborted) note(`Vente arrêtée. ${sellSummary(stats)}`, "warn");
      else note(`Vente interrompue : ${e.message} ${sellSummary(stats)}`, "err");
    } finally {
      await leaveSelection();
      // Filtres du site remis comme avant (toutes les étiquettes, toutes les raretés).
      const reset = { abort: false };
      try {
        await setTagFilter(reset, "Toutes les étiquettes");
        await setRarityFilter(reset, new Set());
      } catch (e) {
        log("filtres non remis à zéro :", e.message);
      }
      if (held) release();
      selling = null;
      if (ui) {
        ui.progress.hidden = true;
        renderPanel();
      }
      refresh();
    }
  }

  function progress(p, pages) {
    const n = [...pages.values()].reduce((s, cs) => s + cs.length, 0);
    ui.progress.hidden = false;
    ui.bar.style.width = `${Math.round((100 * pages.size) / p.total)}%`;
    ui.ptext.textContent = `Page ${p.page} / ${p.total} · ${plural(n, "carte")} lues`;
  }

  // --- Export de la page (diagnostic, pour adapter l'extension si le site change) -----

  function exportPage() {
    const main = (document.querySelector("main") || document.body).cloneNode(true);
    main.querySelectorAll("script, style, #wmt-host, .wmt-flags").forEach((n) => n.remove());
    main.querySelectorAll("[data-wmt], [data-wmt-ring]").forEach((n) => {
      n.removeAttribute("data-wmt");
      n.removeAttribute("data-wmt-ring");
      n.style.removeProperty("--wmt-c");
    });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const html = `${location.href}\n<!-- Exporté par WikiMasters Tagger le ${new Date().toLocaleString("fr-FR")} -->\n${main.outerHTML}\n`;
    const a = h("a", { href: URL.createObjectURL(new Blob([html], { type: "text/html" })), download: `wikimasters-${route || "page"}-${stamp}.html` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    note("Page exportée dans tes téléchargements (uniquement la zone principale, sans tes identifiants).", "ok", null, 8000);
  }

  // --- Panneau ---------------------------------------------------------------------

  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  function tagIcon() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", "M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9Z");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2.2");
    path.setAttribute("stroke-linejoin", "round");
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", "8");
    dot.setAttribute("cy", "8");
    dot.setAttribute("r", "1.7");
    dot.setAttribute("fill", "currentColor");
    svg.append(path, dot);
    return svg;
  }

  function buildPanel() {
    const host = h("div", { id: "wmt-host" });
    const shadow = host.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(PANEL_CSS);
    shadow.adoptedStyleSheets = [sheet];
    const r = {};
    const ref = (name, el) => (r[name] = el);
    const onPulls = route === "pulls";

    const cardsSection = h("section", {},
      h("h4", {}, onPulls ? "Cartes tirées" : "Cette page"),
      ref("pageCount", h("div", { class: "big" }, "…")),
      onPulls ? ref("pulledList", h("div", { class: "pulls" })) : ref("pageTags", h("div", { class: "chips" })),
      h("label", { class: "toggle" },
        h("span", {}, "Surligner les cartes à étiqueter"),
        ref("hl", h("input", { type: "checkbox", class: "switch", onchange: (e) => setSetting("highlight", e.target.checked) }))),
      onPulls && h("label", { class: "toggle", title: "Après ton clic sur « Ouvrir » : fait défiler les cartes du paquet puis clique sur « Continuer »" },
        h("span", {}, "Défiler les cartes puis « Continuer »"),
        ref("auto", h("input", { type: "checkbox", class: "switch", onchange: (e) => setSetting("autoReveal", e.target.checked) }))),
      onPulls && h("label", { class: "toggle", title: "Après ton clic sur « Ouvrir » : rouvre les paquets disponibles à ce moment-là, un par un" },
        h("span", {}, "Enchaîner les paquets disponibles"),
        ref("chain", h("input", { type: "checkbox", class: "switch", onchange: (e) => setSetting("autoChain", e.target.checked) }))),
      onPulls && h("label", { class: "toggle", title: "Sous ta supervision : ouvre les paquets dès qu'ils sont disponibles, même onglet caché. « Arrêter le pilote » l'arrête." },
        h("span", {}, "Pilote : ouvrir les paquets dès qu'ils arrivent"),
        ref("pilot", h("input", { type: "checkbox", class: "switch", onchange: (e) => setSetting("autoOpen", e.target.checked) }))),
      onPulls && h("label", { class: "toggle", title: "Une fois le stock vide : étiquette les cartes tirées dans la Collection, puis revient ici." },
        h("span", {}, "Puis étiqueter les cartes tirées"),
        ref("pilotTag", h("input", { type: "checkbox", class: "switch", onchange: (e) => setSetting("autoTagPulled", e.target.checked) }))),
      onPulls && ref("pilotStatus", h("p", { class: "muted", hidden: true })),
      onPulls && ref("pilotStop", h("button", { class: "link", hidden: true, onclick: () => stopPilot("Pilote arrêté.") }, "Arrêter le pilote")),
      onPulls && ref("autoStatus", h("p", { class: "muted", hidden: true })),
      onPulls && ref("autoStop", h("button", { class: "link", hidden: true, onclick: () => stopAll("Automatique arrêté.") }, "Arrêter")));

    const sections = onPulls
      ? [
          h("section", {},
            h("h4", {}, "Paquets"),
            ref("packCount", h("div", { class: "big" }, "…")),
            ref("packInfo", h("p", { class: "muted" })),
            ref("packNotif", h("p", { class: "muted" })),
            h("button", { class: "link", onclick: () => openPage("options", false, "#packs") }, "Régler les rappels et le type de compte"),
            ref("note", h("div", { class: "note", hidden: true }))),
          cardsSection,
        ]
      : [
          ref("prompt", h("section", { class: "prompt", hidden: true },
            h("div", { class: "big" }, "Analyser ta collection ?"),
            ref("promptText", h("p", { class: "muted" })),
            h("div", { class: "row" },
              h("button", { class: "btn primary", onclick: () => runScan() }, "Lancer l'analyse"),
              h("button", { class: "btn", onclick: later }, "Plus tard")))),
          cardsSection,
          h("section", {},
            h("h4", {}, "Collection"),
            ref("scanInfo", h("div", { class: "muted" })),
            ref("progress", h("div", { hidden: true },
              h("div", { class: "bar" }, ref("bar", h("i"))),
              ref("ptext", h("div", { class: "muted" })))),
            ref("note", h("div", { class: "note", hidden: true })),
            ref("scanBtn", h("button", { class: "btn primary", onclick: () => runScan() }, "Analyser toute la collection")),
            ref("stopBtn", h("button", { class: "btn", hidden: true, onclick: () => scanning && (scanning.abort = true) }, "Arrêter l'analyse")),
            ref("homeBtn", h("button", { class: "btn", hidden: true, onclick: () => location.reload() }, "↺ Revenir à la page 1"))),
          h("section", {},
            h("h4", {}, "Étiquetage automatique"),
            h("p", { class: "muted small" },
              "Pose dans le jeu toutes les étiquettes suggérées, page par page. Seules les étiquettes qui existent déjà dans le jeu sont posées. " +
              "Un clic ou une touche ailleurs que dans ce panneau arrête tout."),
            ref("tagBtn", h("button", { class: "btn accent", onclick: () => runAutoTag() }, "Étiqueter toute la collection")),
            ref("tagRestart", h("button", { class: "link", hidden: true, onclick: () => runAutoTag(false, true) }, "Recommencer depuis la page 1")),
            ref("tagStop", h("button", { class: "btn", hidden: true, onclick: stopTagging }, "Arrêter l'étiquetage"))),
          h("section", {},
            h("h4", {}, "Vendre les cartes sans étiquette"),
            h("p", { class: "muted small" },
              "Défausse, contre 1 wikibidou chacune, toutes tes cartes sans étiquette des raretés choisies, page par page. Irréversible."),
            ref("sellChips", h("div", { class: "rchips" }, RARITY_ORDER.map((r) => {
              const chip = h("button", { class: "rchip", "data-r": r, title: `Vendre les ${r} sans étiquette`, onclick: () => toggleSellRarity(r) }, r);
              chip.style.setProperty("--r", `var(--color-rarity-${r.toLowerCase()}, #b8f2d5)`);
              return chip;
            }))),
            h("label", { class: "toggle" },
              h("span", { title: "Les favoris sont toujours gardés : le site les verrouille (ni défausse, ni vente, ni échange)." }, "Garder aussi les cartes shiny"),
              ref("sellKeep", h("input", { type: "checkbox", class: "switch", onchange: (e) => setSetting("sellKeep", e.target.checked) }))),
            ref("sellBtn", h("button", { class: "btn danger", onclick: askSell }, "Vendre les cartes sans étiquette…")),
            ref("sellStop", h("button", { class: "btn", hidden: true, onclick: stopSelling }, "Arrêter la vente"))),
          h("section", {},
            h("h4", {}, "Catégorisation"),
            h("label", { class: "toggle" },
              h("span", {}, "Enrichir avec Wikidata"),
              ref("wd", h("input", { type: "checkbox", class: "switch", onchange: (e) => setSetting("wikidata", e.target.checked) }))),
            ref("wdHint", h("p", { class: "muted small", hidden: true }, "Ajoute ton e-mail dans la config : Wikimedia demande un moyen de contact.")),
            ref("catBtn", h("button", { class: "btn", onclick: () => openPage("report", true) }, "Catégoriser et ouvrir le rapport"))),
        ];

    const panel = ref("panel", h("div", { class: "panel", hidden: true },
      h("header", {},
        h("b", {}, "Wiki", h("em", {}, "Masters"), " Tagger"),
        h("small", { class: "ver", title: "Version de l'extension" }, extensionVersion()),
        h("button", { class: "icon", title: "Réduire", onclick: () => setOpen(false) }, "–")),
      sections,
      h("footer", {},
        h("a", { onclick: () => openPage("report") }, "Rapport"),
        h("a", { onclick: () => openPage("options") }, "Config"),
        h("a", { title: "Enregistre le HTML de la page pour adapter l'extension si le site change", onclick: exportPage }, "Exporter la page"))));

    const fab = ref("fab", h("button", { class: "fab", title: "WikiMasters Tagger", onclick: () => setOpen(true) },
      h("span", { class: "dot" }, tagIcon()),
      ref("fabLabel", h("span", {}, "Tagger")),
      ref("fabN", h("span", { class: "n", hidden: true }))));

    shadow.append(h("div", { class: "root" }, panel, fab));
    document.body.append(host);
    ui = { host, ...r };
    setOpen(sessionStorage.getItem(`wmt-open-${route}`) === "1");
    renderPanel();
  }

  function setOpen(open) {
    if (!ui) return;
    ui.panel.hidden = !open;
    ui.fab.hidden = open;
    sessionStorage.setItem(`wmt-open-${route}`, open ? "1" : "0");
  }

  let noteTimer = 0;

  /** Message du panneau ; ttl (ms) : s'efface tout seul (0 = reste jusqu'au prochain message). */
  function note(text, kind = "", action = null, ttl = 0) {
    if (!ui || !ui.note) return;
    clearTimeout(noteTimer);
    ui.note.hidden = !text;
    ui.note.className = `note ${kind}`;
    ui.note.replaceChildren(text || "");
    if (action) ui.note.append(h("button", { class: "link", onclick: action.onclick }, action.label));
    if (text && ttl) noteTimer = setTimeout(() => note(null), ttl);
  }

  function later() {
    sessionStorage.setItem("wmt-later", "1");
    ui.prompt.hidden = true;
  }

  function maybePrompt() {
    if (route !== "collection") return;
    const stale = !scanMeta || Date.now() - scanMeta.at > 24 * 3600 * 1000;
    if (!config.settings.autoPrompt || !stale || sessionStorage.getItem("wmt-later")) return;
    ui.prompt.hidden = false;
    setOpen(true);
  }

  function estimate(pages) {
    const s = Math.round((pages * (Math.max(300, +config.settings.pageDelay || 1000) + 700)) / 1000);
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")}`;
  }

  async function setSetting(key, value) {
    if ((key === "autoReveal" || key === "autoChain") && !value) stopAll();
    if (key === "autoReveal" && !value && config.settings.autoOpen) config.settings.autoOpen = false;
    config = { ...config, settings: { ...config.settings, [key]: value } };
    memo = new Map();
    if (key === "autoOpen" || key === "autoReveal") {
      if (pilotOn()) startPilot();
      else pausePilot();
    }
    renderPanel();
    refresh();
    await safe(() => store.saveConfig(config));
  }

  function toggleSellRarity(r) {
    const cur = new Set(config.settings.sellRarities || []);
    cur.has(r) ? cur.delete(r) : cur.add(r);
    note(null);
    setSetting("sellRarities", RARITY_ORDER.filter((x) => cur.has(x)));
  }

  const openPage = (page, run = false, hash = "") => safe(() => chrome.runtime.sendMessage({ type: "open", page, run, hash }));

  function renderPanel() {
    if (!ui) return;
    const s = config.settings;
    ui.hl.checked = !!s.highlight;
    if (route === "pulls") {
      ui.auto.checked = !!s.autoReveal;
      ui.chain.checked = !!s.autoChain;
      ui.chain.disabled = !s.autoReveal;
      ui.pilot.checked = !!s.autoOpen;
      ui.pilot.disabled = !s.autoReveal;
      ui.pilotTag.checked = s.autoTagPulled !== false;
      ui.pilotTag.disabled = !s.autoOpen;
      renderPacks();
      renderAuto();
      return;
    }
    ui.wd.checked = !!s.wikidata;
    ui.wdHint.hidden = !(s.wikidata && !s.contact);
    ui.scanInfo.textContent = scanMeta
      ? `Dernière analyse : ${fmtDate(scanMeta.at)} · ${plural(scanMeta.n, "carte")} · ${scanMeta.pages} pages`
      : "Pas encore analysée.";
    const busy = !!(scanning || tagging || selling);
    ui.scanBtn.hidden = busy;
    ui.stopBtn.hidden = !scanning;
    ui.tagBtn.hidden = busy;
    ui.tagStop.hidden = !tagging;
    // Reprise d'un étiquetage interrompu (vérifiée au lancement : même nombre de pages).
    const resume = tagResume ? resumePage(tagResume.total) : null;
    ui.tagBtn.textContent = resume ? `Reprendre l'étiquetage (page ${resume} / ${tagResume.total})` : "Étiqueter toute la collection";
    ui.tagRestart.hidden = busy || !resume;
    const chosen = new Set(s.sellRarities || []);
    for (const chip of ui.sellChips.children) chip.classList.toggle("on", chosen.has(chip.dataset.r));
    ui.sellKeep.checked = s.sellKeep !== false;
    ui.sellBtn.hidden = busy;
    ui.sellBtn.disabled = !chosen.size;
    ui.sellStop.hidden = !selling;
    ui.catBtn.disabled = !scanMeta || !!scanning;
    ui.catBtn.className = scanMeta && !scanning ? "btn accent" : "btn";
  }

  function renderPage(n, todo, perTag) {
    if (!ui) return;
    ui.pageCount.textContent = n ? `${plural(todo, "carte")} à étiqueter sur ${n}` : "Aucune carte détectée sur cette page.";
    if (focusTag && !perTag.has(focusTag)) focusTag = null;
    const order = config.rules.map((r) => r.name);
    ui.pageTags.replaceChildren(...[...perTag]
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([tag, count]) => {
        const chip = h("button", {
          class: "chip" + (focusTag === tag ? " on" : ""),
          title: focusTag === tag ? "Tout surligner" : "Ne surligner que cette étiquette",
          onclick: () => {
            focusTag = focusTag === tag ? null : tag;
            refresh();
          },
        }, `${tag} · ${count}`);
        chip.style.setProperty("--c", colorOf(tag));
        return chip;
      }));
    ui.fabN.hidden = !todo;
    ui.fabN.textContent = String(todo);
    const p = dom.pager();
    if (p) {
      ui.promptText.textContent =
        `Je parcours les ${p.total} pages de ta collection (≈ ${estimate(p.total)}) pour lire tes cartes, ` +
        "puis tu lances la catégorisation. Rien n'est modifié dans le jeu.";
    }
  }

  // --- Cycle de vie ----------------------------------------------------------------

  function mount() {
    buildPanel();
    observer = new MutationObserver(onMutations);
    // « disabled » : un bouton qui redevient cliquable relance le défilement s'il s'était arrêté.
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled"] });
    if (route === "pulls") packsTimer = setInterval(() => renderPacks(), 30000);
    refresh();
    maybePrompt();
    // Pilote : attente des paquets sur les Paquets, étiquetage des cartes tirées sur la Collection.
    if (route === "pulls") startPilot();
    if (route === "collection" && pilotOn() && config.settings.autoTagPulled && pilot.pending.length) {
      setTimeout(() => route === "collection" && runPilotTag(), 1500);
    }
  }

  function unmount() {
    if (observer) observer.disconnect();
    observer = null;
    clearInterval(packsTimer);
    pausePilot();
    if (scanning) scanning.abort = true;
    if (tagging) tagging.abort = true;
    if (selling) selling.abort = true;
    stopAll();
    clearHighlights();
    if (ui) ui.host.remove();
    ui = null;
    focusTag = null;
  }

  let orphaned = false;
  let ticks = 0;
  let sanctionSent = false;

  /** Une sanction affichée arrête aussi la collecte du marché, pour de bon. */
  function stopMarketForSanction() {
    if (sanctionSent || orphaned) return;
    sanctionSent = true;
    chrome.runtime.sendMessage({ type: "marketStop", reason: "Le site affiche une sanction : collecte du marché arrêtée." }).catch(() => {});
  }

  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function extensionVersion() {
    try {
      return "v" + chrome.runtime.getManifest().version;
    } catch {
      return "";
    }
  }

  function tick() {
    if (!orphaned && !extensionAlive()) {
      // L'extension a été rechargée : ce script n'est plus le bon, il arrête tout automatisme.
      orphaned = true;
      stopAll();
      note("L'extension a été mise à jour : recharge la page (F5) pour utiliser la nouvelle version.", "err");
    }
    if (++ticks % 20 === 0 && !sanctionSent && document.body && dom.sanction()) stopMarketForSanction();
    const next = document.body ? routeOf() : null;
    if (next === route) return;
    if (route) unmount();
    route = next;
    if (route) mount();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.type === "driveDetached") {
      act.resetScale();
      holds = 0;
      if (scanning) scanning.abort = true;
      if (tagging) tagging.abort = true;
      if (selling) selling.abort = true;
      if (autoRun || chain) stopAll();
      if (msg.reason === "canceled_by_user") note("Bandeau de débogage fermé : automatique arrêté (il en a besoin pour cliquer).", "warn", null, 15000);
    }
    if (msg && msg.type === "pilotWake") pilotTick();
    if (msg && msg.type === "panel") {
      if (route) setOpen(true);
      reply({ ok: !!route });
    }
    // Collecte du marché : GET en lecture seule avec la session de l'onglet, quand le service
    // worker n'a pas la session (401). Uniquement l'API du marché.
    if (msg && msg.type === "marketGet" && !orphaned && /^\/api\/marketplace[/?]/.test(msg.path)) {
      fetch(msg.path, { credentials: "same-origin", headers: { accept: "application/json" } })
        .then(async (r) => reply({ status: r.status, body: r.ok ? await r.json() : null }))
        .catch(() => reply({ status: 0, body: null }));
      return true; // réponse asynchrone
    }
  });

  loadState().then(() => {
    tick();
    setInterval(tick, 700); // navigation interne (Next.js) : l'URL change sans recharger la page
  });

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .root {
      --accent: var(--color-accent, #34d399);
      --line: var(--color-border, #2e3431);
      --surface: var(--color-surface, #131615);
      --surface-2: var(--color-surface-light, #1b1f1d);
      --ink: var(--color-foreground, #f2f4f3);
      --heading: var(--font-heading, "Outfit", system-ui, sans-serif);
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
      display: flex; flex-direction: column; align-items: flex-end;
      color: var(--ink); font: 13px/1.45 var(--font-body, "Inter", system-ui, sans-serif);
    }
    [hidden] { display: none !important; }
    .fab {
      display: flex; align-items: center; gap: 8px; padding: 8px 12px 8px 8px;
      border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--ink);
      font: 600 13px/1 var(--heading); cursor: pointer; box-shadow: 0 8px 30px rgba(0,0,0,.45);
    }
    .fab:hover { border-color: var(--accent); }
    .dot { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--accent); color: #0f172a; }
    .n { padding: 3px 7px; border-radius: 999px; background: var(--accent); color: #0f172a; font-size: 11px; }
    .panel {
      width: 320px; max-height: min(80vh, 660px); overflow: auto;
      border: 1px solid var(--line); border-radius: 16px; background: var(--surface);
      box-shadow: 0 18px 50px rgba(0,0,0,.55);
    }
    header { display: flex; align-items: center; gap: 8px; padding: 14px 14px 10px 16px; }
    header b { flex: 1; font: 800 16px/1 var(--heading); letter-spacing: -.01em; }
    .ver { opacity: .45; font: 500 11px/1 var(--heading); }
    header em { font-style: normal; color: var(--accent); }
    .icon { padding: 0 6px; border: 0; background: none; color: inherit; font-size: 20px; line-height: 1; opacity: .6; cursor: pointer; }
    .icon:hover { opacity: 1; }
    section { padding: 12px 16px; border-top: 1px solid var(--line); }
    .prompt { background: color-mix(in srgb, var(--accent) 10%, transparent); }
    h4 { margin: 0 0 6px; font: 600 11px/1 var(--heading); letter-spacing: .07em; text-transform: uppercase; opacity: .55; }
    .big { font: 700 15px/1.3 var(--heading); }
    p { margin: 6px 0 0; }
    .muted { opacity: .65; font-size: 12.5px; }
    .small { font-size: 12px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .chips:empty { display: none; }
    .chip {
      padding: 3px 9px; border: 1px solid color-mix(in srgb, var(--c) 60%, transparent); border-radius: 999px;
      background: color-mix(in srgb, var(--c) 16%, transparent); color: inherit;
      font: 600 11.5px/1.3 var(--font-body, "Inter", system-ui, sans-serif); cursor: pointer;
    }
    .chip.on { background: var(--c); color: #0f172a; }
    .pulls { display: grid; gap: 7px; margin-top: 8px; }
    .pulls:empty { display: none; }
    .pull { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12.5px; }
    .pull .t { font-weight: 600; }
    .rar { padding: 1px 5px; border-radius: 5px; color: #0d1117; font: 700 10.5px/1.3 var(--heading); }
    .tag { padding: 2px 8px; border-radius: 999px; background: var(--c); color: #0f172a; font: 600 11px/1.3 var(--font-body, "Inter", system-ui, sans-serif); cursor: help; }
    .btn {
      width: 100%; margin-top: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px;
      background: var(--surface-2); color: inherit; font: 600 13px/1 var(--heading); cursor: pointer;
    }
    .btn:hover:not(:disabled) { border-color: var(--accent); }
    .btn.primary { border-color: transparent; background: var(--accent); color: #0f172a; }
    .btn.primary:hover:not(:disabled) { filter: brightness(1.08); }
    .btn.accent { border-color: var(--accent); color: var(--accent); }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    .btn.danger { border-color: rgba(255,101,104,.55); color: #ff6568; }
    .rchips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .rchip {
      padding: 4px 12px; border: 0; border-radius: 999px; cursor: pointer;
      background: color-mix(in srgb, var(--r) 19%, transparent); color: var(--r);
      font: 600 12px/1.3 var(--heading); opacity: .5; transition: opacity .15s, box-shadow .15s;
    }
    .rchip:hover { opacity: .8; }
    .rchip.on { opacity: 1; box-shadow: 0 0 0 2px rgba(255,255,255,.3); }
    .row { display: flex; gap: 8px; }
    .toggle { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; cursor: pointer; }
    .switch {
      position: relative; flex: none; width: 34px; height: 20px; margin: 0; border-radius: 999px;
      background: var(--line); appearance: none; cursor: pointer; transition: background .15s;
    }
    .switch::after {
      content: ""; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px;
      border-radius: 50%; background: #fff; transition: transform .15s;
    }
    .switch:checked { background: var(--accent); }
    .switch:checked::after { transform: translateX(14px); }
    .bar { height: 6px; margin: 8px 0 4px; overflow: hidden; border-radius: 999px; background: var(--line); }
    .bar i { display: block; width: 0; height: 100%; background: var(--accent); transition: width .25s; }
    .note { margin-top: 10px; padding: 9px 11px; border: 1px solid var(--line); border-radius: 10px; font-size: 12.5px; }
    .note.ok { border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
    .note.warn { border-color: rgba(250,153,49,.5); background: rgba(250,153,49,.12); }
    .note.err { border-color: rgba(255,101,104,.55); background: rgba(255,101,104,.12); }
    .link { display: block; margin-top: 6px; padding: 0; border: 0; background: none; color: var(--accent); font: 600 12.5px/1.3 var(--heading); cursor: pointer; text-align: left; }
    footer { display: flex; justify-content: space-between; gap: 10px; padding: 10px 16px 14px; border-top: 1px solid var(--line); }
    footer a { color: var(--accent); font: 600 12.5px/1 var(--heading); cursor: pointer; }
    footer a:hover { text-decoration: underline; }
  `;
})();
