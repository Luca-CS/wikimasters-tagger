// Pilote (lib/driver.js) avec un faux chrome.debugger : attachement unique, émulation du focus,
// séquence d'un clic, touches, détachement signalé à l'onglet.
const test = require("node:test");
const assert = require("node:assert/strict");

const calls = [];
const sent = [];
globalThis.chrome = {
  debugger: {
    async attach(target, version) { calls.push(["attach", target.tabId, version]); },
    async detach(target) { calls.push(["detach", target.tabId]); },
    async sendCommand(target, method, params) { calls.push([method, target.tabId, params]); return {}; },
    onDetach: { addListener() {} },
  },
  tabs: { sendMessage: async (tabId, msg) => sent.push([tabId, msg]) },
};
require("../lib/driver.js");
const { driver } = globalThis.WMT;
const sender = { tab: { id: 7 } };

test("premier ordre : attachement unique avec émulation du focus", async () => {
  calls.length = 0;
  assert.deepEqual(await driver.handle({ op: "attach" }, sender), { ok: true, attached: true });
  await driver.handle({ op: "attach" }, sender);
  assert.equal(calls.filter((c) => c[0] === "attach").length, 1);
  assert.ok(calls.filter((c) => c[0] === "Emulation.setFocusEmulationEnabled").every((c) => c[2].enabled === true));
  assert.ok(calls.some((c) => c[0] === "Emulation.setFocusEmulationEnabled"));
});

test("clic : déplacement, appui, relâchement au même point", async () => {
  calls.length = 0;
  assert.equal((await driver.handle({ op: "click", x: 12.5, y: 40 }, sender)).ok, true);
  const mouse = calls.filter((c) => c[0] === "Input.dispatchMouseEvent").map((c) => [c[2].type, c[2].x, c[2].y]);
  assert.deepEqual(mouse, [["mouseMoved", 12.5, 40], ["mousePressed", 12.5, 40], ["mouseReleased", 12.5, 40]]);
});

test("touches et texte", async () => {
  calls.length = 0;
  await driver.handle({ op: "key", key: "Enter" }, sender);
  await driver.handle({ op: "text", text: "12" }, sender);
  const keys = calls.filter((c) => c[0] === "Input.dispatchKeyEvent").map((c) => c[2].type);
  assert.deepEqual(keys, ["keyDown", "keyUp"]);
  assert.ok(calls.some((c) => c[0] === "Input.insertText" && c[2].text === "12"));
  assert.equal((await driver.handle({ op: "key", key: "F13" }, sender)).ok, false);
});

test("sans onglet ou opération inconnue : refus", async () => {
  assert.equal((await driver.handle({ op: "click", x: 1, y: 1 }, {})).ok, false);
  assert.equal((await driver.handle({ op: "zap" }, sender)).ok, false);
});

test("détaché par Chrome (bandeau fermé) : l'onglet est prévenu", async () => {
  sent.length = 0;
  driver.onDetach({ tabId: 7 }, "canceled_by_user"); // branché par background.js
  assert.deepEqual(sent, [[7, { type: "driveDetached", reason: "canceled_by_user" }]]);
  assert.equal(driver.isAttached(7), false);
});
