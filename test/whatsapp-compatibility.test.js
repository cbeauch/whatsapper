const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const { LoadUtils } = require("whatsapp-web.js/src/util/Injected/Utils");
const { Client } = require("whatsapp-web.js");

function createContext(chats, cached = true) {
  const lookups = [];
  const message = { serialize: () => ({
    id: { $1: "false_123@c.us_message", remote: "123@c.us" },
    body: "Test message", type: "chat",
  }) };
  const collections = {
    Chat: { getModelsArray: () => chats },
    Msg: {
      get: (key) => {
        assert.equal(typeof key, "string");
        lookups.push(key);
        return cached ? message : null;
      },
      getMessagesById: async ([key]) => {
        assert.equal(typeof key, "string");
        lookups.push(key);
        return { messages: [message] };
      },
    },
  };
  const window = { require: (name) => {
    if (name === "WAWebCollections") return collections;
    if (name === "WALinkify") return { findLinks: () => [] };
    throw new Error(`Unexpected WhatsApp module: ${name}`);
  } };
  vm.runInNewContext(`(${LoadUtils.toString()})()`, { window });
  return { api: window.WWebJS, lookups };
}

function chat(key) {
  return {
    serialize: () => ({ id: { _serialized: "123@c.us" }, msgs: [{}] }),
    lastReceivedKey: key,
    formattedTitle: "Test chat",
    mute: { expiration: 0 },
  };
}

for (const key of [
  { _serialized: "old-message-key", $1: "new-message-key" },
  { $1: "new-message-key" },
]) {
  test(`loads chats with ${key._serialized ? "legacy" : "renamed"} message keys`, async () => {
    const { api, lookups } = createContext([chat(key)]);
    const models = await api.getChats();
    assert.equal(models.length, 1);
    assert.equal(models[0].formattedTitle, "Test chat");
    assert.equal(models[0].lastMessage.id._serialized, "false_123@c.us_message");
    assert.equal(lookups[0], key._serialized || key.$1);
  });
}

test("loads a renamed message key from storage when it is not cached", async () => {
  const { api, lookups } = createContext([chat({ $1: "new-message-key" })], false);
  const models = await api.getChats();
  assert.equal(models[0].lastMessage.body, "Test message");
  assert.deepEqual(lookups, ["new-message-key", "new-message-key"]);
});

test("keeps chats without a usable last-message key without querying undefined", async () => {
  const { api, lookups } = createContext([chat({}), chat(null)]);
  const models = await api.getChats();
  assert.equal(models.length, 2);
  assert.ok(models.every((model) => model.lastMessage === null));
  assert.equal(lookups.length, 0);
});

function pollVoteHook(collections, onPollVoteEvent) {
  const source = fs.readFileSync(require.resolve("whatsapp-web.js/src/Client"), "utf8");
  const marker = source.indexOf("function: 'pollVoteTableMode.bulkUpsert'");
  const start = source.indexOf("async (module, origFunction, ...args) => {", marker);
  const end = source.indexOf("\n                },", start);
  assert.ok(marker > 0 && start > marker && end > start);
  const callback = source.slice(start, end) + "\n}";
  return vm.runInNewContext(`(${callback})`, {
    Msg: collections,
    window: { WWebJS: { getMsgKeyId: (key) => key?._serialized ?? key?.$1 }, onPollVoteEvent },
    console: { warn: () => {} },
  });
}

for (const parentKey of [{ _serialized: "poll-key" }, { $1: "poll-key" }]) {
  test(`stores live votes before notifying listeners with ${parentKey.$1 ? "renamed" : "legacy"} poll keys`, async () => {
    let stored = false;
    let event;
    const hook = pollVoteHook({ get: (key) => {
      assert.equal(stored, true);
      assert.equal(key, "poll-key");
      return { type: "poll_creation" };
    } }, async (votes) => { event = votes; });
    const incoming = [{ id: "vote-key", pollUpdateParentKey: parentKey, from: { _serialized: "voter@lid" }, t: 1000 }];
    const result = await hook({}, async (votes) => { assert.equal(votes, incoming); stored = true; return "stored"; }, incoming);
    assert.equal(result, "stored");
    assert.equal(event[0].parentMessage.type, "poll_creation");
  });
}

test("a poll lookup or consumer failure cannot prevent live vote storage", async () => {
  for (const failure of ["lookup", "consumer"]) {
    let writes = 0;
    const hook = pollVoteHook({ get: () => {
      if (failure === "lookup") throw new Error("Parent lookup failed");
      return { type: "poll_creation" };
    } }, async () => { throw new Error("Consumer failed"); });
    const result = await hook({}, async () => { writes++; return "stored"; },
      [{ pollUpdateParentKey: { $1: "poll-key" }, from: { _serialized: "voter@lid" }, t: 1000 }]);
    assert.equal(writes, 1);
    assert.equal(result, "stored");
  }
});

test("poll reads query both addressing modes again each time and refuse disconnected data", async () => {
  let state = "CONNECTED", calls = 0;
  const message = { type: "poll_creation", id: { _serialized: "poll-lid" },
    pollOptions: [{ localId: 0, name: "In" }, { localId: 1, name: "Out" }] };
  const context = { window: { require: (name) => {
    if (name === "WAWebSocketModel") return { Socket: { state } };
    if (name === "WAWebMsgKey") return { fromString: () => ({ toString: () => "poll-lid" }) };
    if (name === "WAWebLidMigrationUtils") return { getAlternateMsgKey: () => ({ toString: () => "poll-pn" }) };
    if (name === "WAWebPollsVotesSchema") return { getTable: () => ({ anyOf: async (index, keys) => {
      assert.deepEqual(Array.from(index), ["parentMsgKey"]);
      assert.deepEqual(Array.from(keys), ["poll-lid", "poll-pn"]);
      calls++;
      return Array.from({ length: calls }, (_, i) => ({ sender: `voter-${i}@lid`,
        selectedOptionLocalIds: new Uint8Array([0]).buffer, senderTimestampMs: i, parentMsgKey: "poll-lid" }));
    } }) };
    throw new Error(`Unexpected module ${name}`);
  } }, Uint8Array };
  const client = { getMessageById: async () => message,
    pupPage: { evaluate: async (fn, arg) => vm.runInNewContext(`(${fn.toString()})(msg)`, { ...context, msg: arg }) } };
  const first = await Client.prototype.getPollVotes.call(client, "poll-lid");
  const second = await Client.prototype.getPollVotes.call(client, "poll-lid");
  assert.equal(first.length, 1);
  assert.equal(second.length, 2);
  assert.equal(second[1].selectedOptions[0].name, "In");
  state = "DISCONNECTED";
  await assert.rejects(Client.prototype.getPollVotes.call(client, "poll-lid"), /may be stale/);
  assert.equal(calls, 2);
});
