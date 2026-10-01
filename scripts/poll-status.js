"use strict";

// This command only uses GET. It cannot send a poll, reminder, or chat message.
const fs = require("node:fs/promises");
const path = require("node:path");

async function main() {
  const args = process.argv.slice(2);
  const id = args[0];
  if (!/^\d+$/.test(id || "")) throw new Error("Usage: node scripts/poll-status.js GAME_ID [--json] [--save]");
  if (args.slice(1).some((arg) => !["--json", "--save"].includes(arg))) throw new Error("Unknown option.");
  const response = await fetch(`http://127.0.0.1:4010/hockey/polls/${id}/respondents`, {
    signal: AbortSignal.timeout(60000),
  });
  const report = await response.json();
  if (!response.ok) throw new Error(report.error || `HTTP ${response.status}`);
  if (args.includes("--save")) {
    const folder = path.resolve(__dirname, "../data/hockey-bot/reports");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, `${id}.json`), JSON.stringify(report, null, 2));
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`${report.groupName}: vs ${report.game.opponent} (${report.game.start})`);
  console.log(`${report.summary.responded} responded; ${report.summary.notResponded} have not responded (${report.summary.eligibleMembers} other members; connected account excluded).`);
  console.log(`In: ${report.summary.in}; Out: ${report.summary.out}; Game Time Decision: ${report.summary.gameTimeDecision}; Beer Guy: ${report.summary.beerGuy} (separate role).`);
  for (const responded of [true, false]) {
    console.log(`\n${responded ? "RESPONDED" : "NOT RESPONDED"}`);
    for (const member of report.members.filter((m) => !m.isSender && m.responded === responded)) {
      console.log(`- ${member.name}: ${member.selectedOptions.join(", ") || "No vote"}`);
    }
  }
  const sender = report.members.find((m) => m.isSender);
  if (sender) console.log(`\nConnected account (${sender.name}): ${sender.selectedOptions.join(", ") || "vote unavailable"}; excluded from counts and reminders.`);
  if (report.unmatchedVoters.length) console.log("Warning: some voters could not be matched. Resolve identities before any reminders.");
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
