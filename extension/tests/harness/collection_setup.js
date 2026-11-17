// Page Collection de test (snapshot input/…, scripts du site retirés), comme le site de
// novembre 2026 :
// - config de test : pagination rapide, couleur de Maths faussée (doit être reprise du jeu) ;
// - fausse pagination : 4 pages, départ en page 2 ; les pages 1, 3 et 4 reprennent les cartes
//   du snapshot avec un titre suffixé ; « Page X / Y » est un bouton qui ouvre un champ
//   « Aller à la page » (Entrée ou perte du focus = saut, Échap = annuler) ;
// - favoris verrouillés : étoile masquée et mention « Verrouillée (favori) » en mode sélection,
//   jamais comptés dans « Défausser (+N) » ni défaussés.
(function () {
  // Le snapshot peut contenir le panneau et les surlignages de l'extension (export fait avec
  // l'extension active) : on repart d'une page vierge.
  const stale = document.getElementById("wmt-host");
  if (stale) stale.remove();
  document.querySelectorAll(".wmt-flags").forEach((n) => n.remove());
  document.querySelectorAll("[data-wmt], [data-wmt-ring]").forEach((n) => {
    n.removeAttribute("data-wmt");
    n.removeAttribute("data-wmt-ring");
  });

  const c = WMT.defaults.config();
  c.settings.pageDelay = 300;
  c.rules.find((r) => r.name === "Maths").color = "#000000";
  window.__store.config = c;

  const PAGES = 4;
  let page = 2;
  const roots = [...document.querySelectorAll("div.relative.isolate.group")];
  // Contenu de test : le balisage reste celui du snapshot, mais les cartes sans étiquette
  // reçoivent des descriptions qui déclenchent les règles (une sur quatre reste neutre), et une
  // étiquette du jeu devient « Maths » (couleur à reprendre du jeu).
  // Trois étiquettes du jeu par page (Maths, Musique, Mythologie), plus Ski et Shiny absentes
  // du jeu : le scénario d'étiquetage reste sous les 2 min.
  const DESCS = [
    "théorème de géométrie euclidienne sur les triangles rectangles", "compositeur et pianiste allemand", null,
    "dieu du ciel et de la foudre dans la mythologie grecque", "skieur alpin français", null,
  ];
  const chipsOf = (root) => [...root.querySelectorAll("span.rounded-full")].filter((s) => /background-color/.test(s.getAttribute("style") || ""));
  let k = 0;
  for (const r of roots) {
    if (chipsOf(r).length) continue;
    const d = DESCS[k++ % DESCS.length];
    const p = r.querySelector("p");
    if (d && p) p.textContent = d;
  }
  const mathsChip = roots.flatMap(chipsOf).find((s) => s.textContent.trim() === "Finance");
  if (mathsChip) mathsChip.textContent = "Maths";
  const grid = roots[0].parentElement;
  const template = roots.map((r) => r.cloneNode(true));
  const STAR = 'button[aria-label^="Retirer des favoris"]';
  const starredT = new Set(template.map((r, t) => (r.querySelector(STAR) ? t : -1)).filter((t) => t >= 0));
  window.__starredCount = starredT.size;
  const rarityLeaf = (root) => [...root.querySelectorAll("div, span")].find((e) => e.childElementCount === 0 && /^(L|UR|SR|R|PC|C)$/.test(e.textContent.trim()));
  const shiny = location.search.includes("autotag") || location.search.includes("sell");
  if (shiny) {
    // Une carte shiny : l'étiquette Shiny n'existe pas dans ce « jeu » (sautée à l'étiquetage,
    // gardée à la vente).
    const badge = rarityLeaf(template[0]);
    badge.classList.add("shiny-badge");
    badge.innerHTML = `${badge.textContent.trim()}<span aria-hidden="true">✦</span><span class="sr-only"> shiny</span>`;
  }
  if (location.search.includes("sell")) {
    // Une carte sur 5 devient R, que la vente des UR doit épargner.
    template.forEach((r, i) => {
      if (i % 5 === 4) rarityLeaf(r).textContent = "R";
    });
  }
  // Inventaire : 4 « pages » du snapshot (titres suffixés hors page 2). Les filtres du site
  // (« Sans étiquette », raretés) et la défausse s'y appliquent, comme sur le vrai site.
  const inventory = [];
  for (let p = 1; p <= PAGES; p++) {
    template.forEach((r, t) => {
      const base = r.querySelector("h3").textContent.trim();
      const badge = r.querySelector(".shiny-badge") || rarityLeaf(r);
      inventory.push({ t, title: p === 2 ? base : `${base} ·${p}`, rarity: badge ? badge.firstChild.textContent.trim() : "", starred: starredT.has(t) });
    });
  }
  window.__inventory = inventory;
  const filters = { untagged: false, rarities: new Set() };
  window.__filters = filters;
  window.__sold = [];

  // --- Pagination : [« ← Précédent », bouton « Page X / Y », « Suivant → »] ----------------
  const bars = [...document.querySelectorAll('main button[title="Aller à la page…"]')].map((b) => b.parentElement);
  const navButtons = bars.flatMap((bar) => [...bar.querySelectorAll("button")].filter((b) => /Précédent|Suivant/.test(b.textContent)));
  let total = PAGES;
  window.__nav = { next: 0, prev: 0, jump: 0 };

  function middle(bar, node) {
    const [prev, , next] = [...bar.children];
    bar.replaceChildren(prev, node, next);
  }

  function jumpButton(bar) {
    const b = document.createElement("button");
    b.type = "button";
    b.title = "Aller à la page…";
    b.className = "text-sm tabular-nums cursor-pointer underline decoration-dotted";
    b.textContent = `Page ${page} / ${total}`;
    b.addEventListener("click", () => openJump(bar));
    return b;
  }

  function openJump(bar) {
    const span = document.createElement("span");
    span.className = "inline-flex items-center gap-1 text-sm";
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = String(total);
    input.setAttribute("aria-label", "Aller à la page");
    input.value = String(page);
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const n = Number(input.value);
      setPager();
      if (!Number.isInteger(n)) return;
      const t = Math.min(Math.max(1, n), total);
      if (t === page) return;
      window.__nav.jump++;
      page = t;
      reload();
    };
    // Comme le site : value contrôlée, Entrée ou perte du focus = saut, Échap = annuler.
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") {
        done = true;
        setPager();
      }
    });
    input.addEventListener("blur", commit);
    span.append("Page ", input, `/ ${total}`);
    middle(bar, span);
    setTimeout(() => input.focus(), 0);
  }

  function setPager() {
    // Comme le site : pas de pagination quand il n'y a qu'une page.
    bars.forEach((bar) => {
      bar.style.display = total > 1 ? "" : "none";
      middle(bar, total > 1 ? jumpButton(bar) : document.createElement("span"));
    });
    navButtons.forEach((b) => (b.disabled = /Précédent/.test(b.textContent) ? page === 1 : page === total));
  }

  // --- Rechargements, comme sur le site (relevés le 07/10/2026) -------------------------
  // Chaque action qui change la liste la recharge : d'abord un délai sans aucun signe (les
  // anciennes cartes restent affichées et cliquables), puis le chargement (grille estompée,
  // « Chargement… » et icône qui tourne dans la pagination, boutons désactivés,
  // « Actualisation… » dans la barre de sélection), puis les nouvelles cartes. La requête la
  // plus récente l'emporte.
  const QUIET = 500; // ms, comme le site (~0,5 à 1 s)
  const LOAD = 1500; // ms (le site : 2 à 3 s)
  // Le total de pages vient d'une requête séparée, refaite seulement en page 1, qui arrive
  // après les cartes : en attendant, « Page 1 / Y » et « Suivant » restent sur l'ancien total.
  const STATS_LAG = 1200;
  let reloadId = 0;
  let loading = false;
  window.__reloads = 0;
  function setLoading(on) {
    loading = on;
    grid.classList.toggle("opacity-40", on);
    grid.classList.toggle("pointer-events-none", on);
    if (on) {
      bars.forEach((bar) => {
        const s = document.createElement("span");
        s.className = "inline-flex items-center gap-2 text-sm";
        s.innerHTML = '<span class="w-4 h-4 rounded-full animate-spin"></span>Chargement…';
        middle(bar, s);
      });
      navButtons.forEach((b) => (b.disabled = true));
    }
    renderBar();
  }
  function reload() {
    const id = ++reloadId;
    window.__reloads++;
    setTimeout(() => {
      if (id !== reloadId) return;
      setLoading(true);
      setTimeout(() => {
        if (id !== reloadId) return;
        setLoading(false);
        render(page === 1);
      }, LOAD);
    }, QUIET);
  }
  // --- Mode sélection et étiquetage (relevés sur le site le 02/10/2026) ---------------
  // Étiquettes « existant dans le jeu » : pas de Ski ni de Shiny, qui doivent être sautées.
  const GAME_TAGS = {
    Automobile: "134, 239, 172", "Cinéma/Séries/Acteurs": "255, 0, 234", Maths: "1, 199, 252", Musique: "94, 234, 212",
    Mythologie: "251, 113, 133", Roumanie: "245, 236, 0", Royauté: "167, 139, 250",
  };
  window.__gameTags = Object.keys(GAME_TAGS);
  window.__applied = [];
  window.__discarded = 0;
  const added = new Map(); // titre -> Set des étiquettes posées pendant le test
  const titleOf = (root) => root.querySelector("h3").textContent.trim();
  const tagsOf = (root) => [...root.querySelectorAll("span.rounded-full")].map((s) => s.textContent.trim());
  const itemOf = (title) => inventory.find((it) => it.title === title);

  function addChips(root) {
    const tags = added.get(titleOf(root));
    if (!tags) return;
    const zone = root.querySelector("h3").parentElement.querySelector("div.mt-auto");
    let wrap = zone.querySelector("[data-sim-tags]");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.dataset.simTags = "";
      zone.prepend(wrap);
    }
    for (const t of tags) {
      if (tagsOf(root).includes(t)) continue;
      const s = document.createElement("span");
      s.className = "inline-block max-w-[104px] truncate rounded-full border";
      s.style.cssText = `background-color: rgba(${GAME_TAGS[t]}, 0.38); border-color: rgba(${GAME_TAGS[t]}, 0.52);`;
      s.textContent = t;
      wrap.append(s);
    }
  }

  /** Mode sélection : étoile masquée, « Verrouillée (favori) » sur les favoris (comme le site). */
  function decorate(root) {
    const it = itemOf(titleOf(root));
    const star = root.querySelector(STAR) || root.querySelector('button[aria-label^="Ajouter aux favoris"]');
    if (star) star.hidden = selecting;
    root.querySelectorAll("[data-sim-lock]").forEach((n) => n.remove());
    if (selecting && it && it.starred) {
      const lock = document.createElement("span");
      lock.dataset.simLock = "";
      lock.className = "truncate flex items-center gap-0.5";
      lock.innerHTML = '<svg aria-hidden="true"></svg>Verrouillée (favori)';
      root.querySelector("h3").parentElement.append(lock);
    }
  }

  const selBtn = [...document.querySelectorAll("main button")].find((b) => b.textContent.trim().endsWith("lectionner"));
  let selecting = false;
  const selected = new Set();
  let bar = null;
  selBtn.addEventListener("click", () => setTimeout(() => {
    selecting = !selecting;
    selected.clear();
    const toast = document.getElementById("sim-toast");
    if (selecting && toast) toast.remove();
    selBtn.lastChild.textContent = selecting ? "Quitter la sélection" : "Sélectionner";
    [...grid.children].forEach(decorate);
    renderBar();
  }, 120));
  grid.addEventListener("click", (e) => {
    const root = selecting && e.target.closest("div.relative.isolate.group");
    if (!root) return;
    const t = titleOf(root);
    selected.has(t) ? selected.delete(t) : selected.add(t);
    renderBar();
  });

  /** Cartes sélectionnées affichées, et celles que le site défausserait (hors favoris). */
  function selection() {
    const shown = new Set([...grid.children].map(titleOf));
    const all = [...selected].filter((t) => shown.has(t));
    return { all, discardable: all.filter((t) => !(itemOf(t) || {}).starred) };
  }

  function renderBar() {
    if (!selecting) {
      if (bar) bar.remove();
      bar = null;
      return;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "fixed bottom-4 z-[80] flex flex-col";
      document.body.append(bar);
    }
    const { all, discardable } = selection();
    const n = all.length;
    const off = !n || loading ? " disabled" : "";
    bar.innerHTML = (loading ? "<div><span>Actualisation…</span></div>"
      : `<div><span>${n}</span><span>${n > 1 ? "cartes sélectionnées" : "carte sélectionnée"}</span></div>`) +
      `<div><button type="button"${loading ? " disabled" : ""}>Tout sélectionner (page)</button><button type="button"${off}>Étiqueter</button>` +
      `<button type="button" disabled>Retirer l'étiquette</button><button type="button"${!discardable.length || loading ? " disabled" : ""}>Défausser (+${discardable.length})</button></div>`;
    const [allBtn, tag, , discard] = bar.querySelectorAll("button");
    allBtn.addEventListener("click", () => {
      for (const root of grid.children) selected.add(titleOf(root));
      renderBar();
    });
    tag.addEventListener("click", () => setTimeout(openModal, 200));
    discard.addEventListener("click", () => {
      window.__discarded++;
      setTimeout(openDiscard, 200);
    });
  }

  function openModal() {
    const m = document.createElement("div");
    m.className = "fixed inset-0 z-[60] flex items-center justify-center";
    m.innerHTML = `<div><button type="button" aria-label="Fermer"><svg></svg></button><div><div><h2>Appliquer une étiquette</h2>` +
      `<p>Sur ${selected.size} cartes sélectionnées.</p></div></div>` +
      `<div class="sim-body"><input type="text" maxlength="48" placeholder="Chargement…"><div class="sim-list"></div></div></div>`;
    document.body.append(m);
    m.querySelector('[aria-label="Fermer"]').addEventListener("click", () => m.remove());
    setTimeout(() => {
      m.querySelector("input").placeholder = "Chercher ou créer une étiquette…";
      for (const [name, rgb] of Object.entries(GAME_TAGS)) {
        const b = document.createElement("button");
        b.type = "button";
        const s = document.createElement("span");
        s.style.cssText = `background-color: rgba(${rgb}, 0.22)`;
        s.textContent = name;
        b.append(s);
        b.addEventListener("click", () => apply(m, name));
        m.querySelector(".sim-list").append(b);
      }
    }, 400);
  }

  function apply(m, tag) {
    setTimeout(() => {
      let n = 0;
      for (const root of grid.children) {
        const t = titleOf(root);
        if (!selected.has(t) || tagsOf(root).includes(tag)) continue;
        if (!added.has(t)) added.set(t, new Set());
        added.get(t).add(tag);
        n++;
      }
      window.__applied.push({ page, tag, titles: [...selected] });
      m.querySelector(".sim-body").innerHTML = `<p><span>${n}</span> ${n > 1 ? "cartes étiquetées" : "carte étiquetée"}.</p><button type="button">Terminé</button>`;
      m.querySelector(".sim-body button").addEventListener("click", () => m.remove());
      reload(); // le site recharge la collection après avoir posé l'étiquette
    }, 300);
  }

  const cardTags = (it) => [...tagsOf(template[it.t]), ...(added.get(it.title) || [])];
  function visible() {
    return inventory.filter((it) => (!filters.untagged || !cardTags(it).length) &&
      (!filters.rarities.size || filters.rarities.has(it.rarity)));
  }
  let empty = null;
  function render(lateTotal = false) {
    const list = visible();
    const realTotal = Math.max(1, Math.ceil(list.length / 50));
    if (page > realTotal) page = realTotal;
    if (lateTotal && realTotal !== total) {
      setTimeout(() => {
        total = realTotal;
        if (!loading) setPager();
      }, STATS_LAG);
    } else {
      total = realTotal;
    }
    setPager();
    grid.replaceChildren(...list.slice((page - 1) * 50, page * 50).map((it) => {
      const n = template[it.t].cloneNode(true);
      n.querySelector("h3").textContent = it.title;
      addChips(n);
      decorate(n);
      return n;
    }));
    if (empty) empty.remove();
    empty = null;
    if (!list.length) {
      empty = document.createElement("p");
      empty.textContent = "Aucune carte trouvée avec ces filtres.";
      grid.after(empty);
    }
  }

  // --- Filtres du site (relevés le 05/10/2026) ------------------------------------------
  const tagBtn = document.querySelector('button[aria-label="Filtrer par étiquette"]');
  const tagLabel = [...tagBtn.querySelectorAll("span, div")].find((e) => e.childElementCount === 0 && e.textContent.trim()) || tagBtn;
  tagLabel.textContent = "Toutes les étiquettes";
  tagBtn.addEventListener("click", () => {
    const open = document.querySelector('[role="listbox"]');
    if (open) return open.remove();
    const ul = document.createElement("ul");
    ul.setAttribute("role", "listbox");
    for (const label of ["Toutes les étiquettes", "Sans étiquette", ...Object.keys(GAME_TAGS).map((t) => `#${t}`)]) {
      const li = document.createElement("li");
      li.setAttribute("role", "none");
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "option");
      b.textContent = label;
      b.addEventListener("click", () => {
        ul.remove();
        filters.untagged = label === "Sans étiquette";
        tagLabel.textContent = label;
        page = 1;
        reload();
      });
      li.append(b);
      ul.append(li);
    }
    document.body.append(ul);
  });
  for (const chip of [...document.querySelectorAll("main button")].filter((b) => /^(L|UR|SR|R|PC|C)$/.test(b.textContent.trim()))) {
    const r = chip.textContent.trim();
    chip.className = "px-3 py-1 rounded-full text-xs font-semibold opacity-50";
    chip.addEventListener("click", () => {
      filters.rarities.has(r) ? filters.rarities.delete(r) : filters.rarities.add(r);
      chip.className = `px-3 py-1 rounded-full text-xs font-semibold ${filters.rarities.has(r) ? "ring-2" : "opacity-50"}`;
      page = 1;
      reload();
    });
  }

  // --- Défausse : confirmation du site, puis cartes retirées et liste rechargée ----------
  // Comme le site : les favoris sélectionnés ne sont ni comptés ni défaussés.
  function openDiscard() {
    const { discardable } = selection();
    const n = discardable.length;
    const d = document.createElement("div");
    d.className = "fixed inset-0 z-[90] flex items-center justify-center";
    d.innerHTML = `<div class="card-frame"><h3>Défausser ${n} carte${n > 1 ? "s" : ""} ?</h3>` +
      "<p>Un exemplaire de chaque carte sélectionnée sera retiré définitivement.</p>" +
      `<p>Vous recevrez ${n} wikibidou${n > 1 ? "s" : ""}.</p>` +
      '<div><button type="button">Annuler</button><button type="button">Défausser</button></div></div>';
    document.body.append(d);
    const [cancel, confirm] = d.querySelectorAll("button");
    cancel.addEventListener("click", () => d.remove());
    confirm.addEventListener("click", () => setTimeout(() => {
      const titles = selection().discardable;
      for (const t of titles) inventory.splice(inventory.findIndex((it) => it.title === t), 1);
      window.__sold.push({ page, titles });
      d.remove();
      selected.clear();
      renderBar();
      let toast = document.getElementById("sim-toast");
      if (!toast) {
        toast = document.createElement("div");
        toast.id = "sim-toast";
        grid.parentElement.prepend(toast);
      }
      const n2 = titles.length;
      toast.innerHTML = `<span>${n2} carte${n2 > 1 ? "s" : ""} défaussée${n2 > 1 ? "s" : ""} (+${n2} wikibidou${n2 > 1 ? "s" : ""}).</span>`;
      reload();
    }, 300));
  }

  /** Affiche directement une page (vérifications de fin de scénario). */
  window.__showPage = (n) => {
    page = n;
    render();
  };
  navButtons.forEach((b) => b.addEventListener("click", () => {
    window.__clicks = (window.__clicks || 0) + 1;
    const forward = /Suivant/.test(b.textContent);
    window.__nav[forward ? "next" : "prev"]++;
    page += forward ? 1 : -1;
    reload();
  }));
  // Le snapshot montre la page 1 : on affiche la page 2 de l'inventaire comme point de départ.
  render();
})();
