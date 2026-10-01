"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const Fastify = require("fastify");

// Load the actual routes with a fake WhatsApp client and no listening socket.
// This exercises Fastify + its template plugin without starting WhatsApp.
async function setup(t) {
  const app = Fastify();
  const sourcePath = path.resolve(__dirname, "../app/server.js");
  const serverRequire = createRequire(sourcePath);
  let ready = true;
  let destroyed = false;
  const client = {
    getChats: async () => [{ name: "<BISONS>", id: { _serialized: "test@g.us" } }],
    getState: async () => "CONNECTED",
    destroy: async () => { destroyed = true; },
    sendMessage: async () => { throw new Error("Real messages are forbidden in tests"); },
  };
  app.listen = () => {};
  vm.runInNewContext(fs.readFileSync(sourcePath, "utf8"), {
    __dirname: path.dirname(sourcePath),
    process: { env: {}, once: () => {}, exit: () => { throw new Error("Unexpected exit"); } },
    require: (name) => {
      if (name === "fastify") return () => app;
      if (name === "./whatsappClient") return { client, isInitialized: () => ready, getQr: () => null };
      return serverRequire(name);
    },
  }, { filename: sourcePath });
  await app.ready();
  t.after(async () => { await app.close(); assert.equal(destroyed, true); });
  return { app, setReady: (value) => { ready = value; } };
}

test("upgraded web stack renders pages, escapes chat names, and accepts read-only JSON commands", async (t) => {
  const { app } = await setup(t);
  for (const route of ["/", "/qr", "/chats"]) {
    const response = await app.inject({ method: "GET", url: route });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.headers["content-type"], /text\/html/);
    if (route === "/chats") assert.match(response.body, /&lt;BISONS&gt;/);
    if (route === "/qr") assert.match(response.body, /WhatsApp is connected/);
  }
  const response = await app.inject({ method: "POST", url: "/command",
    payload: { command: "getState", params: [] } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { resp: "CONNECTED" });
});

test("health and hockey routes reflect WhatsApp readiness after the upgrade", async (t) => {
  const { app, setReady } = await setup(t);
  assert.equal((await app.inject("/health")).statusCode, 200);
  const invalidSchedule = await app.inject({ method: "POST", url: "/hockey/run",
    payload: { games: [], dryRun: true, scheduleReadAt: new Date().toISOString() } });
  assert.equal(invalidSchedule.statusCode, 500);
  assert.match(invalidSchedule.json().error, /schedule is required/);
  setReady(false);
  const health = await app.inject("/health");
  assert.equal(health.statusCode, 503);
  assert.deepEqual(health.json(), { whatsappReady: false });
  assert.equal((await app.inject("/hockey/polls/123")).statusCode, 503);
});
