// Surenchère automatique du pilote (décidée le 18/11/2026) : logique pure, testée sous Node.
//
// Sur « Marché > Mes enchères », le pilote ouvre chaque enchère « Surenchéri », lit la
// « Moyenne » de la « Vue du marché », puis décide :
//   - mise minimum ≥ facteur × moyenne (facteur réglable par carte) : on ne surenchérit pas ;
//   - solde insuffisant : on ne surenchérit pas ;
//   - plus de 5 min restantes : on mise tout de suite ;
//   - 5 min ou moins : on attend qu'il reste exactement 12 s (une mise dans les 10 dernières
//     secondes prolonge l'enchère de 60 s), puis on revérifie et on mise.
// La mise est toujours la « Mise minimum » affichée par le site, jamais plus.
(function (root) {
  const WMT = (root.WMT = root.WMT || {});
  const SEC = 1000;
  const MIN = 60 * SEC;
  const SNIPE_UNDER = 5 * MIN; // en dessous : mise à 12 s de la fin
  const SNIPE_AT = 12 * SEC;

  /** « 1 414 », « 1 099 », « 150 » -> nombre ; null sinon. */
  function amount(t) {
    const m = String(t || "").replace(/[\s  ]/g, "").match(/^\D*(\d+)\D*$/);
    return m ? +m[1] : null;
  }

  /**
   * Temps restant d'une enchère, en ms : « Se termine dans 47m 58s », « 1h 19m », « 2m 36s »,
   * « 54s », « 2j 3h ». null si illisible (ou « Terminée »).
   */
  function remaining(t) {
    const s = String(t || "").toLowerCase();
    const part = (re) => {
      const m = s.match(re);
      return m ? +m[1] : 0;
    };
    if (!/\d\s*(j|h|m|s)\b/.test(s)) return null;
    const d = part(/(\d+)\s*j\b/);
    const h = part(/(\d+)\s*h\b/);
    const m = part(/(\d+)\s*m\b/);
    const sec = part(/(\d+)\s*s\b/);
    return (((d * 24 + h) * 60 + m) * 60 + sec) * SEC;
  }

  /** Facteur de la carte `title` : réglage par carte, sinon par défaut (1 si absent ou invalide). */
  function factorFor(settings, title) {
    const per = (settings && settings.rebidFactors) || {};
    const own = Number(per[title]);
    if (title in per && own > 0) return own;
    const dflt = Number(settings && settings.rebidFactor);
    return dflt > 0 ? dflt : 1;
  }

  /**
   * Décision pour une enchère surenchérie : {action: "bid" | "wait" | "skip", reason, limit}.
   * `snipe` : on est à l'heure de la mise de dernière minute (on ne réattend pas).
   */
  function decide({ min, avg, factor, balance, remainingMs, snipe = false }) {
    if (!(min > 0)) return { action: "skip", reason: "mise minimum illisible" };
    if (!(avg > 0)) return { action: "skip", reason: "pas de moyenne de prix (aucune vente)" };
    const limit = factor * avg;
    if (!(min < limit)) return { action: "skip", reason: `mise minimum ${min} ≥ ${fmt(factor)} × moyenne ${avg} (${fmt(limit)})`, limit };
    if (balance == null) return { action: "skip", reason: "solde illisible", limit };
    if (balance < min) return { action: "skip", reason: `solde ${balance} < mise minimum ${min}`, limit };
    if (remainingMs == null) return { action: "skip", reason: "temps restant illisible", limit };
    if (remainingMs <= 0) return { action: "skip", reason: "enchère terminée", limit };
    if (!snipe && remainingMs <= SNIPE_UNDER) return { action: "wait", reason: "moins de 5 min : mise à 12 s de la fin", limit };
    return { action: "bid", reason: `mise minimum ${min} < ${fmt(factor)} × moyenne ${avg} (${fmt(limit)})`, limit };
  }

  const fmt = (x) => String(Math.round(x * 100) / 100).replace(".", ",");

  /**
   * Ordre de traitement des enchères surenchéries de la liste : d'abord celles où l'on peut
   * miser tout de suite (plus de 5 min), puis les autres par fin la plus proche.
   */
  function order(cards) {
    const now = (c) => c.remainingMs != null && c.remainingMs > SNIPE_UNDER;
    return [...cards].sort((a, b) => {
      if (now(a) !== now(b)) return now(a) ? -1 : 1;
      return (a.remainingMs ?? Infinity) - (b.remainingMs ?? Infinity);
    });
  }

  WMT.rebid = { SNIPE_UNDER, SNIPE_AT, amount, remaining, factorFor, decide, order };
  if (typeof module !== "undefined") module.exports = WMT.rebid;
})(globalThis);
