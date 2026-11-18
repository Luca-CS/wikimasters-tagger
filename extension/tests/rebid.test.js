// Surenchère automatique : logique de décision (lib/rebid.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const rebid = require("../lib/rebid.js");

const MIN = 60000;

test("montants : espaces fines et insécables", () => {
  assert.equal(rebid.amount("1 414"), 1414);
  assert.equal(rebid.amount("1 099"), 1099);
  assert.equal(rebid.amount("Mise minimum : 150"), 150);
  assert.equal(rebid.amount(""), null);
});

test("temps restant : formats du site", () => {
  assert.equal(rebid.remaining("Se termine dans 47m 58s"), 47 * MIN + 58000);
  assert.equal(rebid.remaining("1h 19m"), 79 * MIN);
  assert.equal(rebid.remaining("2m 36s"), 2 * MIN + 36000);
  assert.equal(rebid.remaining("54s"), 54000);
  assert.equal(rebid.remaining("2j 3h"), (2 * 24 + 3) * 60 * MIN);
  assert.equal(rebid.remaining("Terminée"), null);
});

test("facteur : par carte, sinon par défaut", () => {
  const s = { rebidFactor: 1.2, rebidFactors: { Incel: 1.5, Bizarre: "x" } };
  assert.equal(rebid.factorFor(s, "Incel"), 1.5);
  assert.equal(rebid.factorFor(s, "Autre"), 1.2);
  assert.equal(rebid.factorFor(s, "Bizarre"), 1.2);
  assert.equal(rebid.factorFor({}, "Incel"), 1);
});

test("décision : prix, solde, temps", () => {
  const base = { min: 150, avg: 130, factor: 1.5, balance: 1414, remainingMs: 48 * MIN };
  assert.equal(rebid.decide(base).action, "bid");
  assert.equal(rebid.decide({ ...base, factor: 1 }).action, "skip"); // 150 ≥ 130
  assert.equal(rebid.decide({ ...base, min: 195 }).action, "skip"); // strictement inférieur
  assert.equal(rebid.decide({ ...base, balance: 149 }).action, "skip");
  assert.equal(rebid.decide({ ...base, avg: null }).action, "skip");
  assert.equal(rebid.decide({ ...base, remainingMs: 5 * MIN }).action, "wait");
  assert.equal(rebid.decide({ ...base, remainingMs: 12000, snipe: true }).action, "bid");
  assert.equal(rebid.decide({ ...base, remainingMs: 0, snipe: true }).action, "skip");
});

test("ordre : mises immédiates d'abord, puis fins les plus proches", () => {
  const cards = [{ id: "a", remainingMs: 2 * MIN }, { id: "b", remainingMs: 90 * MIN }, { id: "c", remainingMs: 30000 }, { id: "d", remainingMs: 10 * MIN }];
  assert.deepEqual(rebid.order(cards).map((c) => c.id), ["d", "b", "c", "a"]);
});
