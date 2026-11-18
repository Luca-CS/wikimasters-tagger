// Simulateur du Marché (pages reconstruites des exports du 18/11/2026, scripts du site retirés).
//   /marketplace/        « Parcourir » affiché ; l'onglet « Mes enchères » montre la liste de
//                        l'export (l'enchère « Incel » y est « Surenchéri »)
//   /marketplace/{id}/   page de l'enchère « Incel » : compteur, solde, mise minimum, historique,
//                        « Vue du marché » (Moyenne), « Miser »
// Paramètres (gardés par pulls_setup.js dans __simQuery) : end=secondes restantes au départ,
// avg=moyenne affichée, balance=solde. État commun aux pages dans sessionStorage (__simMarket) ;
// chaque mise reçue est notée dans __simBids : {amount, remainingMs, trusted}.
(function () {
  const Q = new URLSearchParams(sessionStorage.getItem("__simQuery") || location.search);
  const ME = "Moi_Test";
  const clean = (s) => String(s || "").replace(/[\s  ]+/g, " ").trim();
  const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const load = () => JSON.parse(sessionStorage.getItem("__simMarket") || "null");
  const save = (s) => sessionStorage.setItem("__simMarket", JSON.stringify(s));
  let sim = load();
  if (!sim) {
    sim = {
      endAt: Date.now() + (+(Q.get("end") || 1200)) * 1000,
      current: 136, min: 150, balance: +(Q.get("balance") || 1414), avg: +(Q.get("avg") || 130),
      leader: "Rival_1",
      history: [["Rival_1", "18 nov., 18:40", 136], ["Joueur_2", "18 nov., 18:32", 123], ["Rival_1", "18 nov., 16:55", 111]],
    };
    save(sim);
  }
  const minBid = (c) => Math.max(Math.ceil(1.1 * c), c + 1);
  const left = () => Math.max(0, sim.endAt - Date.now());
  const dur = (ms) => {
    const s = Math.ceil(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}h ${String(m).padStart(2, "0")}m` : m ? `${m}m ${String(sec).padStart(2, "0")}s` : `${sec}s`;
  };
  const main = document.querySelector("main");
  const leafText = (re) => [...main.querySelectorAll("span, p, div")].filter((e) => e.childElementCount === 0 && re.test(clean(e.textContent)));

  // --- Liste --------------------------------------------------------------------------------
  const boxes = [...main.querySelectorAll('[id^="marketplace-auction-"]')];
  if (boxes.length) {
    const grid = boxes[0].parentElement;
    const tabs = [...main.querySelectorAll("button")].filter((b) => /^(Parcourir|Mes ventes|Mes enchères|Gagnées|Historique)/.test(clean(b.textContent)));
    const mine = tabs.find((b) => /^Mes enchères/.test(clean(b.textContent)));
    grid.hidden = true; // « Parcourir » par défaut, comme le site
    window.__simTab = "Parcourir";
    mine.addEventListener("click", () => setTimeout(() => {
      grid.hidden = false;
      window.__simTab = "Mes enchères";
    }, 300));
    const incel = boxes.find((b) => clean(b.querySelector("h3").textContent) === "Incel");
    const tick = () => {
      if (!incel) return;
      const status = incel.querySelector("a span");
      status.textContent = sim.leader === ME ? "Vous menez" : "Surenchéri";
      const d = [...incel.querySelectorAll("span")].find((s) => clean(s.textContent) === "Durée");
      if (d && d.nextElementSibling) d.nextElementSibling.textContent = dur(left());
    };
    tick();
    setInterval(() => {
      sim = load();
      tick();
    }, 250);
    return;
  }

  // --- Page d'une enchère -------------------------------------------------------------------
  const ends = leafText(/^Se termine dans /)[0];
  const minEl = leafText(/^Mise minimum : /)[0];
  const input = main.querySelector('input[aria-label="Montant de la mise"]');
  const miser = [...main.querySelectorAll("button")].find((b) => clean(b.textContent) === "Miser");
  const balEl = [...main.querySelectorAll("span")].find((s) => /^Votre solde :/.test(clean(s.textContent))).querySelector("span");
  const leadEl = [...main.querySelectorAll("p")].find((p) => /^Meneur :/.test(clean(p.textContent))).querySelector("span");
  const cur = [...main.querySelectorAll("span")].find((s) => clean(s.textContent) === "Mise actuelle").nextElementSibling;
  const hist = [...main.querySelectorAll("h2")].find((h) => /^Historique des mises/.test(clean(h.textContent)));
  const ul = hist.parentElement.querySelector("ul");
  const rowTemplate = ul.firstElementChild.cloneNode(true);

  function render() {
    ends.textContent = left() > 0 ? `Se termine dans ${dur(left())}` : "Terminée";
    minEl.textContent = `Mise minimum : ${sim.min}`;
    if (document.activeElement !== input && !input.dataset.touched) input.value = String(sim.min);
    input.min = String(sim.min);
    balEl.textContent = fmt(sim.balance);
    leadEl.textContent = sim.leader;
    cur.lastChild.textContent = String(sim.current);
    hist.textContent = `Historique des mises (${sim.history.length})`;
    if (ul.children.length !== sim.history.length) {
      ul.replaceChildren(...sim.history.map(([name, when, amount]) => {
        const li = rowTemplate.cloneNode(true);
        const a = li.querySelector("a");
        a.textContent = name;
        a.title = `Voir le profil de ${name}`;
        const spans = li.querySelectorAll("span span");
        spans[0].textContent = when;
        spans[spans.length - 1].lastChild.textContent = String(amount);
        return li;
      }));
    }
  }
  render();
  setInterval(render, 200);
  input.addEventListener("input", () => (input.dataset.touched = "1"));

  // « Vue du marché » : la fenêtre de l'export, Moyenne réglée par le scénario.
  main.querySelector('button[aria-label="Vue du marché"]').addEventListener("click", () => setTimeout(() => {
    if (!window.MARKET_VIEW || document.getElementById("sim-view")) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = window.MARKET_VIEW;
    const view = wrap.firstElementChild;
    view.id = "sim-view";
    const avg = [...view.querySelectorAll("p")].find((p) => clean(p.textContent) === "Moyenne");
    avg.nextElementSibling.lastChild.textContent = fmt(sim.avg);
    view.querySelector('button[aria-label="Fermer"]').addEventListener("click", () => setTimeout(() => view.remove(), 150));
    document.body.append(view);
    window.__simViews = (window.__simViews || 0) + 1;
  }, 250));

  // « Retour au marché » : un bouton (navigation du site), vers la liste du marché.
  const back = [...main.querySelectorAll("button")].find((b) => clean(b.textContent) === "Retour au marché");
  if (back) back.addEventListener("click", () => setTimeout(() => location.assign("/marketplace/"), 150));

  miser.addEventListener("click", (e) => {
    const amount = +String(input.value).replace(/\D/g, "");
    const remainingMs = left();
    const bids = JSON.parse(sessionStorage.getItem("__simBids") || "[]");
    bids.push({ amount, remainingMs, trusted: e.isTrusted, ok: amount >= sim.min && amount <= sim.balance && remainingMs > 0 });
    sessionStorage.setItem("__simBids", JSON.stringify(bids));
    if (!bids[bids.length - 1].ok) return;
    setTimeout(() => {
      sim.history.unshift([ME, "à l'instant", amount]);
      sim.current = amount;
      sim.leader = ME;
      sim.balance -= amount;
      sim.min = minBid(amount);
      if (remainingMs < 10000) sim.endAt += 60000; // prolongation du site
      delete input.dataset.touched;
      save(sim);
      render();
    }, 700);
  });
})();
