const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Poll } = require("whatsapp-web.js");
const { HockeyBot, attendance, daysUntil, GROUP_ID, OPTIONS } = require("../app/hockeyBot");

const game = { id: "21825", opponent: "No Regretzkys", arena: "R Kohn", start: "2026-10-14T22:00:00-06:00", cancelled: false };
const members = ["bot@c.us", "in@c.us", "out@c.us", "decision@c.us", "beer@c.us", "missing@c.us"];

async function setup(t, now = "2026-10-12T09:00:00-06:00") {
  const root = path.resolve(__dirname, "../.local");
  await fs.mkdir(root, { recursive: true });
  const stateDir = await fs.mkdtemp(path.join(root, "hockey-test-"));
  t.after(async () => {
    if (!stateDir.startsWith(root + path.sep)) throw new Error("Unsafe test cleanup path.");
    await fs.rm(stateDir, { recursive: true, force: true });
  });
  let clock = new Date(now);
  const sent = [];
  const client = {
    info: { wid: { _serialized: members[0] } },
    getChatById: async () => ({ name: "BISONS", isGroup: true, id: { _serialized: GROUP_ID },
      participants: members.map((id) => ({ id: { _serialized: id } })) }),
    sendMessage: async (to, content, options) => {
      sent.push({ to, content, options });
      return { id: { _serialized: `sent-${sent.length}` } };
    },
    getMessageById: async () => ({ type: "poll_creation", fromMe: true, to: GROUP_ID,
      allowMultipleAnswers: true, pollOptions: OPTIONS.map((name, localId) => ({ name, localId })) }),
    getPollVotes: async () => [],
    getContactLidAndPhone: async (ids) => ids.map((id) => ({ pn: id, lid: `${id.split("@")[0]}@lid` })),
  };
  const bot = new HockeyBot(client, { stateDir, now: () => clock });
  return { bot, client, sent, setClock: (value) => { clock = new Date(value); }, stateDir };
}

function vote(voter, names) {
  return { voter, selectedOptions: names.map((name) => ({ name, localId: OPTIONS.indexOf(name) })), interractedAtTs: 1 };
}

test("one-off creates one native multi-choice poll and survives concurrent requests and restarts", async (t) => {
  const { bot, client, sent, stateDir } = await setup(t);
  const results = await Promise.all([bot.poll(game, { oneOff: true }), bot.poll(game, { oneOff: true })]);
  assert.equal(sent.length, 1);
  assert.equal(results[1].status, "already-sent");
  assert.ok(sent[0].content instanceof Poll);
  assert.deepEqual(sent[0].content.pollOptions.map((o) => o.name), OPTIONS);
  assert.equal(sent[0].content.options.allowMultipleAnswers, true);
  assert.match(sent[0].content.pollName, /Sent from Bison Bot/);
  assert.ok(sent[0].content.pollName.length <= 255);
  const restarted = new HockeyBot(client, { stateDir, now: bot.now });
  assert.equal((await restarted.poll(game, { oneOff: true })).status, "already-sent");
  assert.equal(sent.length, 1);
});

test("uncertain delivery is recorded and never retried automatically", async (t) => {
  const { bot, client, sent } = await setup(t);
  client.sendMessage = async () => { sent.push({}); throw new Error("Connection lost after send"); };
  await assert.rejects(bot.poll(game, { oneOff: true }), /Connection lost/);
  await assert.rejects(bot.poll(game, { oneOff: true }), /uncertain/);
  assert.equal(sent.length, 1);
});

test("two-day reminder mentions only beer-only voters and non-voters; game day also mentions pending decisions", async (t) => {
  const { bot, client, sent, setClock } = await setup(t);
  await bot.poll(game, { oneOff: true });
  client.getPollVotes = async () => [vote("in@lid", ["In", "Beer Guy"]), vote("out@c.us", ["Out"]),
    vote("decision@c.us", ["Game Time Decision"]), vote("beer@c.us", ["Beer Guy"])];
  await bot.reminder(game);
  assert.deepEqual(sent[1].options.mentions, ["beer@c.us", "missing@c.us"]);
  assert.equal(sent[1].options.quotedMessageId, "sent-1");
  await bot.reminder(game);
  assert.equal(sent.length, 2);
  setClock("2026-10-14T09:00:00-06:00");
  await bot.reminder(game);
  assert.deepEqual(sent[2].options.mentions, ["beer@c.us", "missing@c.us", "decision@c.us"]);
  assert.match(sent[2].content, /make your decision/);
});

test("failed vote lookup and missing saved poll both suppress reminders", async (t) => {
  const { bot, client, sent } = await setup(t);
  await bot.poll(game, { oneOff: true });
  client.getPollVotes = async () => { throw new Error("Votes unavailable"); };
  await assert.rejects(bot.reminder(game), /Votes unavailable/);
  assert.equal(sent.length, 1);
  client.getMessageById = async () => null;
  await assert.rejects(bot.reminder(game), /could not be verified/);
  assert.equal(sent.length, 1);
});

test("scheduler reuses the early poll and refuses stale schedules or changed fixtures", async (t) => {
  const { bot, sent, setClock } = await setup(t, "2026-10-11T09:00:00-06:00");
  await bot.poll(game, { oneOff: true });
  let result = await bot.run([game], { dryRun: true, scheduleReadAt: "2026-10-11T09:00:00-06:00" });
  assert.equal(result.plans.length, 0);
  setClock("2026-10-12T09:00:00-06:00");
  result = await bot.run([game], { dryRun: true, scheduleReadAt: "2026-10-12T09:00:00-06:00" });
  assert.equal(result.plans[0].action, "reminder");
  assert.equal(sent.length, 1);
  await assert.rejects(bot.run([game], { scheduleReadAt: "2026-10-11T09:00:00-06:00" }), /within ten minutes/);
  result = await bot.run([{ ...game, start: "2026-10-14T21:00:00-06:00" }],
    { scheduleReadAt: "2026-10-12T09:00:00-06:00" });
  assert.match(result.errors[0].error, /changed/);
  assert.equal(result.plans.length, 0);
  setClock("2026-10-13T09:00:00-06:00");
  result = await bot.run([game], { dryRun: true, scheduleReadAt: "2026-10-13T09:00:00-06:00" });
  assert.equal(result.plans.length, 0);
});

test("a withdrawn vote, contradictory selections, and beer alone do not resolve attendance", () => {
  assert.equal(attendance([], false), "unresolved");
  assert.equal(attendance(["Beer Guy"], false), "unresolved");
  assert.equal(attendance(["In", "Out"], true), "unresolved");
  assert.equal(attendance(["Game Time Decision"], false), "pending");
  assert.equal(attendance(["Game Time Decision"], true), "decision");
  assert.equal(attendance(["Out", "Beer Guy"], true), "resolved");
});

test("read-only report matches LID voters, excludes sender from counts, and preserves withdrawn votes", async (t) => {
  const { bot, client, sent } = await setup(t);
  await bot.poll(game, { oneOff: true });
  client.getPollVotes = async () => [vote("bot@lid", ["Out"]), vote("in@lid", ["In", "Beer Guy"]),
    vote("beer@c.us", ["Beer Guy"]), vote("decision@c.us", ["Game Time Decision"]),
    vote("out@c.us", ["Out"]), { ...vote("out@c.us", []), interractedAtTs: 2 }];
  const report = await bot.responses(game.id, { includeNames: false });
  assert.equal(sent.length, 1, "Reading must not send anything");
  assert.equal(report.unmatchedVoters.length, 0);
  assert.equal(report.summary.responded, 3);
  assert.equal(report.summary.notResponded, 2);
  assert.equal(report.summary.in, 1);
  assert.equal(report.summary.out, 0);
  assert.equal(report.summary.beerGuy, 2);
  assert.equal(report.members.find((m) => m.isSender).attendance, "Out");
  assert.equal(report.members.find((m) => m.id === "beer@c.us").responded, true);
  assert.equal(report.members.find((m) => m.id === "beer@c.us").attendance, "Undecided");
});

test("an unavailable connected-account vote is unknown and never counted as missing", async (t) => {
  const { bot, client, sent } = await setup(t);
  await bot.poll(game, { oneOff: true });
  client.getPollVotes = async () => [vote("in@lid", ["In"])];
  const report = await bot.responses(game.id, { includeNames: false });
  assert.equal(report.summary.eligibleMembers, 5);
  assert.equal(report.summary.responded, 1);
  assert.equal(report.summary.notResponded, 4);
  assert.equal(report.members.find((m) => m.isSender).responded, null);
  assert.equal(report.members.find((m) => m.isSender).attendance, "Unknown");
  assert.equal(sent.length, 1);
});

test("test dates preview reminders and overlapping polls without changing time, state, or sending", async (t) => {
  const { bot, client, sent } = await setup(t, "2026-09-30T09:00:00-06:00");
  await bot.poll(game, { oneOff: true });
  client.getPollVotes = async () => [vote("in@lid", ["In", "Beer Guy"]), vote("out@lid", ["Out"]),
    vote("decision@lid", ["Game Time Decision"]), vote("beer@lid", ["Beer Guy"])];
  const before = await bot.read(game.id);
  const options = { dryRun: true, scheduleReadAt: bot.now().toISOString() };
  const twoDays = await bot.run([game], { ...options, asOf: "2026-10-12T09:00:00-06:00" });
  assert.deepEqual(twoDays.plans[0].recipients.map((m) => m.id), ["beer@c.us", "missing@c.us"]);
  const nextGame = { ...game, id: "21828", start: "2026-10-17T15:00:00-06:00" };
  const gameDay = await bot.run([game, nextGame], { ...options, asOf: "2026-10-14T09:00:00-06:00" });
  assert.deepEqual(gameDay.plans.map((p) => p.action), ["reminder", "poll"]);
  assert.deepEqual(gameDay.plans[0].recipients.map((m) => m.id), ["beer@c.us", "missing@c.us", "decision@c.us"]);
  const dayBefore = await bot.run([game], { ...options, asOf: "2026-10-13T09:00:00-06:00" });
  assert.equal(dayBefore.plans.length, 0);
  assert.equal(sent.length, 1);
  assert.deepEqual(await bot.read(game.id), before);
  assert.equal(await bot.read(nextGame.id), null);
  assert.equal(bot.now().toISOString(), "2026-09-30T15:00:00.000Z");
  await assert.rejects(bot.run([game], { ...options, dryRun: false, asOf: "2026-10-12T09:00:00-06:00" }), /only allowed in dry-run/);
  await assert.rejects(bot.run([game], { ...options, asOf: "2026-10-12" }), /Invalid test date/);
});

test("dry-run message and poll drafts match the real send payloads", async (t) => {
  const { bot, client, sent, setClock } = await setup(t);
  await bot.poll(game, { oneOff: true });
  client.getPollVotes = async () => [vote("in@lid", ["In"]), vote("out@lid", ["Out"]),
    vote("decision@lid", ["Game Time Decision"]), vote("beer@lid", ["Beer Guy"])];
  let preview = await bot.run([game], { dryRun: true, scheduleReadAt: bot.now().toISOString() });
  assert.equal(preview.plans[0].willSend, true);
  assert.match(preview.plans[0].message.text, /Sent from Bison Bot/);
  assert.equal(sent.length, 1);
  await bot.reminder(game);
  assert.equal(sent[1].content, preview.plans[0].message.text);
  assert.deepEqual(sent[1].options.mentions, preview.plans[0].message.mentions);
  assert.equal(sent[1].options.quotedMessageId, preview.plans[0].message.quotedMessageId);
  preview = await bot.run([game], { dryRun: true, scheduleReadAt: bot.now().toISOString() });
  assert.deepEqual(preview.plans, [], "Already sent reminders must not be advertised again");
  setClock("2026-10-14T09:00:00-06:00");
  const nextGame = { ...game, id: "21828", start: "2026-10-17T15:00:00-06:00" };
  preview = await bot.run([game, nextGame], { dryRun: true, scheduleReadAt: bot.now().toISOString() });
  assert.match(preview.plans[0].message.text, /@decision.*make your decision/);
  assert.deepEqual(preview.plans[1].message.options, OPTIONS);
  assert.equal(preview.plans[1].message.allowMultipleAnswers, true);
  await bot.run([game, nextGame], { dryRun: false, scheduleReadAt: bot.now().toISOString() });
  assert.equal(sent[2].content, preview.plans[0].message.text);
  assert.equal(sent[3].content.pollName, preview.plans[1].message.title);
  assert.deepEqual(sent[3].content.pollOptions.map((o) => o.name), preview.plans[1].message.options);
});

test("dry run shows no outgoing reminder when all attendance is resolved", async (t) => {
  const { bot, client, sent } = await setup(t);
  await bot.poll(game, { oneOff: true });
  client.getPollVotes = async () => members.slice(1).map((id) => vote(id, ["In"]));
  const preview = await bot.run([game], { dryRun: true, scheduleReadAt: bot.now().toISOString() });
  assert.equal(preview.plans[0].willSend, false);
  assert.equal(preview.plans[0].message, null);
  assert.match(preview.plans[0].reason, /No members need/);
  assert.equal(sent.length, 1);
});

test("every eligible game gets a reminder, even with an earlier game tomorrow", async (t) => {
  const { bot, sent } = await setup(t);
  const tomorrow = { ...game, id: "100", start: "2026-10-13T22:00:00-06:00" };
  const second = { ...game, id: "101", start: "2026-10-14T23:00:00-06:00" };
  for (const fixture of [tomorrow, game, second]) await bot.poll(fixture, { oneOff: true });
  const options = { scheduleReadAt: bot.now().toISOString() };
  const preview = await bot.run([second, tomorrow, game], options);
  assert.deepEqual(preview.plans.map((p) => [p.game.id, p.action]), [[game.id, "reminder"], [second.id, "reminder"]]);
  assert.deepEqual(preview.errors, []);
  assert.equal(sent.length, 3);
  for (const plan of preview.plans) {
    assert.match(plan.message.text, /Bisons vs No Regretzkys/);
    assert.match(plan.message.text, /Wednesday, October 14, 2026/);
    assert.match(plan.message.text, /R Kohn/);
  }
  assert.match(preview.plans[0].message.text, /10:00/);
  assert.match(preview.plans[1].message.text, /11:00/);
  assert.equal(preview.plans[0].message.quotedMessageId, "sent-2");
  assert.equal(preview.plans[1].message.quotedMessageId, "sent-3");
  const live = await bot.run([second, tomorrow, game], { ...options, dryRun: false });
  assert.equal(live.results.length, 2);
  assert.equal(sent.length, 5);
  assert.deepEqual((await bot.run([game, second], options)).plans, []);
});

test("missing polls are created once on days zero through three, never outside the window", async (t) => {
  const { bot, sent } = await setup(t);
  const fixtures = [0, 1, 2, 3, 4].map((day) => ({ ...game, id: String(100 + day),
    start: `2026-10-${12 + day}T22:00:00-06:00` }));
  const options = { scheduleReadAt: bot.now().toISOString() };
  const preview = await bot.run(fixtures, options);
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.plans.map((p) => p.game.id), ["100", "101", "102", "103"]);
  assert.ok(preview.plans.every((p) => p.action === "poll"));
  assert.equal(sent.length, 0);
  await bot.run(fixtures, { ...options, dryRun: false });
  assert.equal(sent.length, 4);
  assert.deepEqual((await bot.run(fixtures, options)).plans, [], "Do not immediately remind about a new catch-up poll");
  await bot.run(fixtures, { ...options, dryRun: false });
  assert.equal(sent.length, 4);
  await assert.rejects(bot.poll(fixtures[4]), /within three/);
});

test("outside-window state cannot block games, and cancelled or started games are skipped", async (t) => {
  const { bot, sent } = await setup(t);
  const distant = { ...game, id: "200", start: "2026-10-16T22:00:00-06:00" };
  await bot.write({ game: distant, status: "sending" });
  const cancelled = { ...game, id: "201", cancelled: true };
  const started = { ...game, id: "202", start: "2026-10-12T09:00:00-06:00" };
  const old = { ...game, id: "203", start: "2026-10-11T22:00:00-06:00" };
  const preview = await bot.run([distant, cancelled, started, old, game], { scheduleReadAt: bot.now().toISOString() });
  assert.deepEqual(preview.plans.map((p) => p.game.id), [game.id]);
  assert.deepEqual(preview.errors, []);
  assert.equal(sent.length, 0);
});

test("one uncertain poll does not block another game in previews or sends", async (t) => {
  const { bot, sent } = await setup(t);
  await bot.write({ game, status: "sending" });
  const other = { ...game, id: "300", start: "2026-10-15T22:00:00-06:00" };
  const options = { scheduleReadAt: bot.now().toISOString() };
  const preview = await bot.run([game, other], options);
  assert.match(preview.errors[0].error, /uncertain/);
  assert.deepEqual(preview.plans.map((p) => p.game.id), [other.id]);
  const live = await bot.run([game, other], { ...options, dryRun: false });
  assert.match(live.errors[0].error, /uncertain/);
  assert.equal(live.results[0].game.id, other.id);
  assert.equal(sent.length, 1);
});

test("invalid inputs, duplicate IDs and changed fixtures cannot cause sends", async (t) => {
  const { bot, sent } = await setup(t);
  const options = { scheduleReadAt: bot.now().toISOString() };
  for (const bad of [{ start: "2026-02-30T22:00:00-07:00" }, { start: "2026-10-14T24:00:00-06:00" },
    { cancelled: "true" }, { arena: " " }, { opponent: {} }]) {
    await assert.rejects(bot.run([{ ...game, ...bad }], options), /A game needs/);
  }
  await assert.rejects(bot.run([game, game], options), /Duplicate/);
  await assert.rejects(bot.run([game], { ...options, dryRun: "false" }), /boolean/);
  await assert.rejects(bot.run([game], { ...options, asOf: "2026-02-30T09:00:00-07:00" }), /Invalid test date/);
  await assert.rejects(bot.run([game], { scheduleReadAt: "2026-10-12" }), /within ten minutes/);
  assert.equal(sent.length, 0);
  await bot.poll(game, { oneOff: true });
  await assert.rejects(bot.poll({ ...game, arena: "Elsewhere" }, { oneOff: true }), /changed/);
  assert.equal(sent.length, 1);
});

test("calendar days handle both DST transitions, UTC midnight and year rollover", () => {
  for (const [start, now] of [
    ["2026-03-09T22:00:00-06:00", "2026-03-06T09:00:00-07:00"],
    ["2026-11-02T22:00:00-07:00", "2026-10-30T09:00:00-06:00"],
    ["2027-01-02T22:00:00-07:00", "2026-12-30T09:00:00-07:00"],
    ["2026-10-15T04:00:00Z", "2026-10-12T05:59:59Z"],
  ]) assert.equal(daysUntil({ start }, new Date(now)), 3);
});

test("unknown poll options, unmapped sender and invalid vote timestamps stop reminders", async (t) => {
  const { bot, client, sent } = await setup(t);
  await bot.poll(game, { oneOff: true });
  const originalMessage = client.getMessageById;
  client.getMessageById = async () => ({ ...(await originalMessage()), pollOptions: [{ name: "Yes" }] });
  await assert.rejects(bot.reminder(game), /could not be verified/);
  client.getMessageById = originalMessage;
  client.getPollVotes = async () => [{ ...vote("in@lid", ["In"]), interractedAtTs: undefined }];
  await assert.rejects(bot.reminder(game), /Unrecognized vote data/);
  client.getPollVotes = async () => [];
  client.info.wid._serialized = "unknown@c.us";
  await assert.rejects(bot.reminder(game), /sending account could not be matched/);
  assert.equal(sent.length, 1);
});

test("oversized polls fail before persisting an uncertain send", async (t) => {
  const { bot, sent } = await setup(t);
  await assert.rejects(bot.poll({ ...game, opponent: "x".repeat(256) }), /exceeds 255/);
  assert.equal(await bot.read(game.id), null);
  assert.equal(sent.length, 0);
});

test("a lookup crossing puck drop cannot send a late reminder", async (t) => {
  const { bot, client, sent, setClock } = await setup(t, "2026-10-14T09:00:00-06:00");
  const early = { ...game, start: "2026-10-14T09:01:00-06:00" };
  await bot.poll(early, { oneOff: true });
  client.getPollVotes = async () => { setClock(early.start); return []; };
  await assert.rejects(bot.reminder(early), /window ended/);
  assert.equal(sent.length, 1);
});

test("scheduled sends are restricted to 9 AM Mountain, while previews can run anytime", async (t) => {
  const { bot, sent } = await setup(t, "2026-10-12T10:00:00-06:00");
  const options = { scheduleReadAt: bot.now().toISOString() };
  await assert.rejects(bot.run([game], { ...options, dryRun: false }), /9 AM/);
  assert.equal((await bot.run([game], options)).plans.length, 1);
  assert.equal(sent.length, 0);
});

test("slow lookups cannot carry scheduled messages past the 9 AM hour", async (t) => {
  const { bot, client, sent, setClock } = await setup(t);
  await bot.poll(game, { oneOff: true });
  client.getPollVotes = async () => { setClock("2026-10-12T10:00:00-06:00"); return []; };
  await assert.rejects(bot.reminder(game), /9 AM/);
  assert.equal(sent.length, 1);
  setClock("2026-10-12T09:59:00-06:00");
  const originalGroup = client.getChatById;
  client.getChatById = async () => { setClock("2026-10-12T10:00:00-06:00"); return originalGroup(); };
  await assert.rejects(bot.poll({ ...game, id: "500" }), /9 AM/);
  assert.equal(sent.length, 1);
  assert.equal(await bot.read("500"), null);
});
