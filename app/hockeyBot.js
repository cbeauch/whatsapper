"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { Poll } = require("whatsapp-web.js");

const GROUP_ID = "120363299629814601@g.us";
const TIMEZONE = "America/Edmonton";
const OPTIONS = ["In", "Out", "Game Time Decision", "Beer Guy"];
const LABEL = "🦬 Sent from Bison Bot:";

function localDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  return ["year", "month", "day"].map((key) => parts.find((p) => p.type === key).value).join("-");
}

function daysUntil(game, now) {
  return Math.round((Date.parse(localDate(new Date(game.start))) - Date.parse(localDate(now))) / 86400000);
}

function checkSendHour(now) {
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", hourCycle: "h23" }).format(now);
  if (hour !== "09") throw new Error("Scheduled actions run during the 9 AM Mountain hour only; missed reminder windows are not replayed.");
}

function validTimestamp(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) return false;
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10) &&
    Number(value.slice(11, 13)) < 24;
}

function validateGame(input) {
  if (!input || !/^\d+$/.test(String(input.id)) ||
      typeof input.opponent !== "string" || !input.opponent.trim() ||
      typeof input.arena !== "string" || !input.arena.trim() || !validTimestamp(input.start) ||
      (input.cancelled !== undefined && typeof input.cancelled !== "boolean")) {
    throw new Error("A game needs its ALLCAL game ID, opponent, arena, and ISO start time with timezone.");
  }
  return { id: String(input.id), opponent: String(input.opponent), arena: String(input.arena),
    start: input.start, cancelled: input.cancelled === true };
}

function checkState(state, game) {
  if (!state) return;
  if (state.status !== "sent" || !state.messageId) {
    throw new Error(`Game ${game.id} has an uncertain poll send; review the group before continuing.`);
  }
  if (state.groupId !== GROUP_ID || JSON.stringify(state.game) !== JSON.stringify(game)) {
    throw new Error(`Game ${game.id} changed since the poll; review its saved fixture and group before sending.`);
  }
}

function gameDetails(game) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, weekday: "long", month: "long", day: "numeric", year: "numeric",
  }).format(new Date(game.start));
  const time = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, hour: "numeric", minute: "2-digit", hour12: true,
  }).format(new Date(game.start));
  return `Bisons vs ${game.opponent}\n${date} at ${time} — ${game.arena}`;
}

function title(game) {
  return `${LABEL}\n${gameDetails(game)}\nChoose In, Out, or Game Time Decision.`;
}

function attendance(selected, gameDay) {
  const choices = selected.filter((name) => name !== "Beer Guy");
  if (choices.length === 1 && ["In", "Out"].includes(choices[0])) return "resolved";
  if (choices.length === 1 && choices[0] === "Game Time Decision") return gameDay ? "decision" : "pending";
  return "unresolved";
}

function pollDraft(game) {
  const pollTitle = title(game);
  if (pollTitle.length > 255) throw new Error(`Game ${game.id} poll title exceeds 255 characters; shorten its opponent or arena.`);
  return { type: "poll", title: pollTitle, options: [...OPTIONS], allowMultipleAnswers: true };
}

function reminderDraft(game, members, gameDay, messageId) {
  const eligible = members.filter((m) => !m.isSender);
  const unresolved = eligible.filter((m) => attendance(m.selectedOptions, gameDay) === "unresolved");
  const decisions = eligible.filter((m) => attendance(m.selectedOptions, gameDay) === "decision");
  const recipients = [...unresolved, ...decisions].map((m) => ({
    id: m.id, name: m.name, reason: attendance(m.selectedOptions, gameDay),
  }));
  if (!recipients.length) return { recipients, message: null };
  const mentionText = (list) => list.map((m) => `@${m.id.split("@")[0]}`).join(" ");
  const lines = [LABEL, gameDetails(game)];
  if (unresolved.length) lines.push(`${mentionText(unresolved)} Please update the original poll with one attendance answer: ${gameDay ? "In or Out" : "In, Out, or Game Time Decision"}.`);
  if (decisions.length) lines.push(`${mentionText(decisions)} It's game day! Please make your decision and update the original poll to In or Out.`);
  return { recipients, message: { type: "text", text: lines.join("\n\n"),
    mentions: recipients.map((m) => m.id), quotedMessageId: messageId } };
}

class HockeyBot {
  constructor(client, {
    stateDir = process.env.HOCKEY_STATE_DIR || (process.platform === "win32"
      ? path.join(__dirname, "..", "data", "hockey-bot") : "/data/hockey-bot"),
    now = () => new Date(),
  } = {}) {
    this.client = client;
    this.stateDir = stateDir;
    this.now = now;
    this.queue = Promise.resolve();
  }

  exclusive(action) {
    const run = this.queue.then(action);
    this.queue = run.catch(() => {});
    return run;
  }

  async read(id) {
    try { return JSON.parse(await fs.readFile(path.join(this.stateDir, `${id}.json`), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  async write(state) {
    await fs.mkdir(this.stateDir, { recursive: true });
    const target = path.join(this.stateDir, `${state.game.id}.json`);
    await fs.writeFile(`${target}.tmp`, JSON.stringify(state, null, 2));
    await fs.rename(`${target}.tmp`, target);
  }

  async group() {
    const group = await this.client.getChatById(GROUP_ID);
    if (!group?.isGroup || group.id._serialized !== GROUP_ID || group.name !== "BISONS") {
      throw new Error("The configured BISONS group could not be verified.");
    }
    return group;
  }

  poll(input, { oneOff = false } = {}) {
    return this.exclusive(async () => {
      const game = validateGame(input);
      const now = this.now();
      if (game.cancelled || Date.parse(game.start) <= now.getTime()) throw new Error("Game is cancelled or has started.");
      if (!oneOff && ![0, 1, 2, 3].includes(daysUntil(game, now))) throw new Error("Regular polls are due within three calendar days of the game.");
      const previous = await this.read(game.id);
      checkState(previous, game);
      if (previous) {
        return { status: "already-sent", messageId: previous.messageId, game: previous.game };
      }
      const draft = pollDraft(game);
      await this.group();
      if (Date.parse(game.start) <= this.now().getTime()) throw new Error("Game started while verifying the group; nothing was sent.");
      if (!oneOff) checkSendHour(this.now());
      const state = { game, groupId: GROUP_ID, status: "sending", requestedAt: now.toISOString(), oneOff, reminders: {} };
      await this.write(state);
      // Persist the attempt first: an exception after transmission must not cause a duplicate poll.
      const message = await this.client.sendMessage(GROUP_ID,
        new Poll(draft.title, draft.options, { allowMultipleAnswers: draft.allowMultipleAnswers }),
        { sendSeen: false, waitUntilMsgSent: true });
      if (!message?.id?._serialized) throw new Error("Poll send returned no message ID. Review the group; do not resend blindly.");
      state.messageId = message.id._serialized;
      state.status = "sent";
      state.sentAt = this.now().toISOString();
      await this.write(state);
      return { status: "sent", messageId: state.messageId, game };
    });
  }

  async pollVotes(state) {
    const message = await this.client.getMessageById(state.messageId);
    if (state.groupId !== GROUP_ID || !message || message.type !== "poll_creation" || !message.fromMe || message.to !== GROUP_ID ||
        message.allowMultipleAnswers !== true ||
        JSON.stringify(message.pollOptions?.map((o) => o.name)) !== JSON.stringify(OPTIONS)) {
      throw new Error("The saved poll could not be verified; reminders are deferred.");
    }
    const votes = await this.client.getPollVotes(state.messageId);
    if (!Array.isArray(votes)) throw new Error("Poll vote retrieval failed.");
    return votes;
  }

  async verify(id) {
    if (!/^\d+$/.test(String(id))) throw new Error("Invalid game ID.");
    const state = await this.read(id);
    if (!state?.messageId) throw new Error("No saved poll for this game.");
    const message = await this.client.getMessageById(state.messageId);
    const votes = await this.pollVotes(state);
    return { game: state.game, status: state.status, messageId: state.messageId,
      type: message.type, ack: message.ack, voteRows: votes.length,
      options: message.pollOptions?.map((o) => o.name), allowMultipleAnswers: message.allowMultipleAnswers };
  }

  async responses(id, { includeNames = true } = {}) {
    if (!/^\d+$/.test(String(id))) throw new Error("Invalid game ID.");
    const state = await this.read(id);
    if (!state?.messageId || state.status !== "sent") throw new Error("No confirmed poll for this game.");
    const group = await this.group();
    const memberIds = group.participants.map((p) => p.id._serialized);
    if (memberIds.some((id) => !id)) throw new Error("Some group members lack usable IDs.");
    const self = this.client.info.wid._serialized;
    const identities = await this.client.getContactLidAndPhone([...new Set([...memberIds, self])]);
    const aliases = new Map([...memberIds, self].map((id) => [id, id]));
    for (const identity of identities) {
      const canonical = memberIds.find((id) => id === identity.lid || id === identity.pn) || identity.pn || identity.lid;
      if (identity.lid) aliases.set(identity.lid, canonical);
      if (identity.pn) aliases.set(identity.pn, canonical);
    }
    if (!memberIds.includes(aliases.get(self))) throw new Error("The sending account could not be matched to a current group member.");
    const votes = await this.pollVotes(state);
    const selected = new Map();
    if (votes.some((vote) => !vote || typeof vote.voter !== "string" || !vote.voter ||
        !Array.isArray(vote.selectedOptions) || !Number.isFinite(vote.interractedAtTs))) throw new Error("Unrecognized vote data.");
    for (const vote of [...votes].sort((a, b) => a.interractedAtTs - b.interractedAtTs)) {
      const options = [...new Set(vote.selectedOptions.map((o) => o?.name || OPTIONS[o?.localId]))];
      if (options.some((name) => !OPTIONS.includes(name))) throw new Error("Unrecognized poll option.");
      selected.set(aliases.get(vote.voter) || vote.voter, options);
    }
    const unmatchedVoters = [...selected.keys()].filter((id) => !memberIds.includes(id));
    const members = await Promise.all(memberIds.map(async (id) => {
      const options = selected.get(id) || [];
      const answers = options.filter((option) => option !== "Beer Guy");
      let name = id;
      if (includeNames) {
        try {
          const contact = await this.client.getContactById(id);
          name = contact.name || contact.pushname || contact.shortName || id;
        } catch (_) { /* The identifier remains usable if a contact name is unavailable. */ }
      }
      return { id, name, isSender: id === (aliases.get(self) || self), responded: options.length > 0,
        selectedOptions: options, beerGuy: options.includes("Beer Guy"),
        attendance: answers.length === 1 ? answers[0] : answers.length ? "Conflicting" : "Undecided" };
    }));
    // Votes made on the connected account's phone may not sync to WhatsApp Web.
    // Keep it out of reminder counts rather than treating an absent vote as no response.
    for (const member of members) {
      if (member.isSender && !member.responded) {
        member.responded = null;
        member.attendance = "Unknown";
      }
    }
    const eligible = members.filter((m) => !m.isSender);
    return { groupId: GROUP_ID, groupName: group.name, game: state.game, messageId: state.messageId,
      checkedAt: this.now().toISOString(), unmatchedVoters, members,
      summary: { groupMembers: members.length, eligibleMembers: eligible.length,
        responded: eligible.filter((m) => m.responded).length,
        notResponded: eligible.filter((m) => !m.responded).length,
        in: eligible.filter((m) => m.attendance === "In").length,
        out: eligible.filter((m) => m.attendance === "Out").length,
        gameTimeDecision: eligible.filter((m) => m.attendance === "Game Time Decision").length,
        beerGuy: eligible.filter((m) => m.beerGuy).length } };
  }

  reminder(input) {
    return this.exclusive(async () => {
      const game = validateGame(input);
      const day = daysUntil(game, this.now());
      if (game.cancelled || Date.parse(game.start) <= this.now().getTime() || ![0, 2].includes(day)) {
        throw new Error("Reminders are only due two days before and on game day before puck drop.");
      }
      checkSendHour(this.now());
      const state = await this.read(game.id);
      checkState(state, game);
      if (!state || state.status !== "sent") throw new Error("No confirmed poll for this game.");
      state.reminders ||= {};
      const window = localDate(this.now());
      if (!state.oneOff && state.sentAt && localDate(new Date(state.sentAt)) === window) {
        return { status: "poll-created-today", gameId: game.id };
      }
      if (state.reminders[window]?.status === "sending") throw new Error("Reminder delivery is uncertain; review before retrying.");
      if (state.reminders[window]) return { status: "already-processed", gameId: game.id };
      const report = await this.responses(game.id, { includeNames: false });
      // Unknown voter identities may be unresolved LIDs: avoid incorrectly nagging people who voted.
      if (report.unmatchedVoters.length) {
        throw new Error("Some voters cannot be matched to current members; review identities before reminding.");
      }
      const draft = reminderDraft(game, report.members, day === 0, state.messageId);
      if (!draft.message) {
        state.reminders[window] = { status: "no-reminder-needed" };
        await this.write(state);
        return { status: "no-reminder-needed", gameId: game.id };
      }
      const { text, mentions, quotedMessageId } = draft.message;
      if (Date.parse(game.start) <= this.now().getTime() || localDate(this.now()) !== window) {
        throw new Error("The reminder window ended while reading votes; nothing was sent.");
      }
      checkSendHour(this.now());
      state.reminders[window] = { status: "sending", recipients: mentions, requestedAt: this.now().toISOString() };
      await this.write(state);
      const message = await this.client.sendMessage(GROUP_ID, text, {
        mentions, quotedMessageId, sendSeen: false, waitUntilMsgSent: true,
      });
      if (!message?.id?._serialized) throw new Error("Reminder delivery is uncertain; review before retrying.");
      state.reminders[window].status = "sent";
      state.reminders[window].messageId = message.id._serialized;
      await this.write(state);
      return { status: "sent", gameId: game.id, recipients: mentions.length, messageId: message.id._serialized };
    });
  }

  async run(inputs, { dryRun = true, scheduleReadAt, asOf } = {}) {
    const actualNow = this.now();
    if (typeof dryRun !== "boolean") throw new Error("dryRun must be a boolean.");
    if (asOf !== undefined && !dryRun) throw new Error("A test date is only allowed in dry-run mode.");
    if (asOf !== undefined && !validTimestamp(asOf)) throw new Error("Invalid test date; supply an ISO timestamp with timezone.");
    const now = asOf === undefined ? actualNow : new Date(asOf);
    if (!Array.isArray(inputs) || !inputs.length) throw new Error("A loaded team schedule is required.");
    if (!validTimestamp(scheduleReadAt) || Math.abs(actualNow.getTime() - Date.parse(scheduleReadAt)) > 600000) {
      throw new Error("Read the schedule CSV within ten minutes before running.");
    }
    const schedule = inputs.map(validateGame);
    if (new Set(schedule.map((g) => g.id)).size !== schedule.length) throw new Error("Duplicate game IDs in the schedule.");
    const games = schedule.filter((g) => !g.cancelled && Date.parse(g.start) > now.getTime() &&
      daysUntil(g, now) >= 0 && daysUntil(g, now) <= 3)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const plans = [];
    const results = [];
    const errors = [];
    if (!dryRun) checkSendHour(actualNow);
    for (const game of games) {
      try {
        const day = daysUntil(game, now);
        const state = await this.read(game.id);
        checkState(state, game);
        let action;
        if (!state) action = "poll";
        else if ([0, 2].includes(day)) {
          // A catch-up poll is today's action; a repeated run must not nag immediately.
          if (!state.oneOff && state.sentAt && localDate(new Date(state.sentAt)) === localDate(now)) continue;
          const previous = state.reminders?.[localDate(now)];
          if (previous?.status === "sending") throw new Error("Reminder delivery is uncertain; review before retrying.");
          if (!previous) action = "reminder";
        }
        if (!action) continue;
        if (!dryRun) {
          checkSendHour(this.now());
          results.push(await (action === "poll" ? this.poll(game) : this.reminder(game)));
        } else {
          const plan = { action, game, groupId: GROUP_ID };
          if (action === "poll") {
            plan.message = pollDraft(game);
            plan.willSend = true;
          } else {
            const report = await this.responses(game.id);
            if (report.unmatchedVoters.length) throw new Error("Some voters cannot be matched; reminder preview is deferred.");
            Object.assign(plan, reminderDraft(game, report.members, day === 0, report.messageId));
            plan.willSend = plan.message !== null;
            if (!plan.willSend) plan.reason = "No members need an attendance reminder in this window.";
          }
          plans.push(plan);
        }
      } catch (error) {
        errors.push({ gameId: game.id, error: error.message || String(error) });
      }
    }
    return dryRun ? { dryRun: true, asOf: now.toISOString(), plans, errors } : { results, errors };
  }
}

function registerHockeyBot(fastify, client, isInitialized) {
  const bot = new HockeyBot(client);
  const handler = (action) => async (request, reply) => {
    if (!isInitialized()) return reply.code(503).send({ error: "WhatsApp is not ready." });
    try { return await action(request); }
    catch (error) {
      fastify.log.error({ err: error }, "Bison Bot operation failed");
      return reply.code(500).send({ error: error.message || String(error) });
    }
  };
  fastify.post("/hockey/poll", handler((req) => bot.poll(req.body.game, { oneOff: req.body.oneOff === true })));
  fastify.get("/hockey/polls/:id", handler((req) => bot.verify(req.params.id)));
  fastify.get("/hockey/polls/:id/respondents", handler((req) => bot.responses(req.params.id)));
  fastify.post("/hockey/run", handler((req) => bot.run(req.body.games, req.body)));
}

module.exports = { HockeyBot, registerHockeyBot, attendance, daysUntil, GROUP_ID, OPTIONS, title };
