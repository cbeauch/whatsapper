# Whatsapper

A tiny web api on [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js)

## Usage

After run, the QR code for association will be displayed on the console.
Is also possible to get the string version from the path `/qr`

After this, whatsapper is logged and you can forward all `whatsapp-web.js` calls via the `/command` api with this json syntax:

```json
{
  "command" : "cmd",
  "params": ["param1", "param2"],
}
```

this will be forwarded to the whatsapp-web.js and you will get back the return of the lib.

## Special commands

To send media, call with a `POST` via the `/command/media` api with this json syntax:

```json
    "params": ["remote_id to send the media to", "image/png", "29y78y424GWIOJFADIJFADS", "filename.png"],
```

## Run

```shell
npm ci
npm start
```

Open http://localhost:3000/qr and scan the QR code from WhatsApp's
**Linked devices → Link a device** screen. The page refreshes automatically.

On Windows, `./start.ps1` now builds and starts Docker Compose at
http://127.0.0.1:4010 (login at `/qr`); Docker Desktop must be running.
For a local Node fallback, use `./start.ps1 -Local` after installing dependencies
and stopping Docker. Local mode stores login data in the project's `data`
directory and Puppeteer's browser in `.local/puppeteer`. Set `PORT` or `HOST` to
override the local Node server address. See the migration notes below before
switching back, so you retain the latest poll history.

The local patch in `patches/whatsapp-web.js+1.34.7.patch` fixes chat loading
when WhatsApp Web uses `$1` for message IDs instead of `_serialized`.
It accepts both fields, preserves serialized message IDs, and avoids querying
message storage with an undefined key. `npm ci` applies it automatically.
Run `npm test` to check compatibility with old, renamed, and missing keys.
This is a temporary fix for the issue discussed in
[upstream PR #201910](https://github.com/wwebjs/whatsapp-web.js/pull/201910).

The same local patch protects live poll-vote storage from event handler errors,
supports renamed poll keys, and reads votes under both phone-number and LID
parent keys. Vote lookup refuses a disconnected WhatsApp session.

## Run with docker compose

```powershell
docker compose up -d --build --wait --wait-timeout 180
docker compose ps
```

Compose runs the locally built image at http://127.0.0.1:4010. The health check
waits for WhatsApp to be ready; `/qr` shows the login screen if linking is needed.
The service restarts automatically when Docker starts, unless explicitly stopped.
Docker Desktop must be running. There is no automatic message-sending job in this
container; the existing Windows task remains disabled and configured for dry runs.

The `whatsapper_whatsapper` named volume contains the WhatsApp login, cached web
client, and poll/reminder history under `/data`. These files are excluded from Git
and Docker build contexts. Rebuilding or recreating the container preserves them.
Keep the volume: `docker compose down -v` would erase the login and poll history.
Source files are baked into the image, so use `docker compose up -d --build` after
code changes. The CSV runner still reads the local `schedule.csv` and calls the
same `127.0.0.1:4010` address from PowerShell.

For the Windows-to-Docker migration, the local browser was closed before copying
the project's `data` contents into the new named volume. The original local data
and a backup under `.local/docker-migration-*` are retained. Run only one bot
instance against the account. To return to the local app, first stop Compose,
export the latest `/data` from the stopped container into the project's `data`
folder, and then run `./start.ps1 -Local`. Local files are no longer updated with poll
state while Docker is running; the named volume is the active source of truth.

## Bison Bot CSV schedule

The deterministic runner reads `schedule.csv` and uses the linked WhatsApp session.
The previous agent instructions are preserved in `docs/agent-drafts/HOCKEY_POLL_AGENT.md`.
No agent automation is required.

The CSV contains the five October fixtures available on the
[ALLCAL team schedule](https://allcalhockey.com/team/6237/schedule) when checked on
September 30, 2026. Maintain this file when fixtures are added, moved, or cancelled;
the runner does not scrape the website. Use an ISO start with its UTC offset
(`-06:00` during Mountain daylight time, `-07:00` during standard time).
Set `cancelled` to `true` to skip a fixture.

Read the current poll without sending anything:

```powershell
node scripts/poll-status.js 21825 --save
./scripts/run-hockey-bot.ps1
```

Preview another date (interpreted as 9 AM Mountain time), including full reminder
text, the people mentioned, poll titles, options, and whether multiple answers
are allowed:

```powershell
./scripts/run-hockey-bot.ps1 -DryRun -Date 2026-10-12
./scripts/run-hockey-bot.ps1 -DryRun -Date 2026-10-14
```

`-AsOf` is an alias for `-Date`. Dry-run is also the default when `-Send` is
absent. A test date cannot be combined with `-Send`, and the API enforces the
same restriction. Test runs use live votes as they exist now, do not change saved
poll/reminder state, and cannot predict votes that will arrive later.
The preview uses the same message builders as sending. It skips reminders already
processed for that date and explains when no message is needed.

The report matches current group members to poll votes, including WhatsApp LID
identities. It lists respondents, non-respondents, attendance choices, and Beer Guy
separately. The connected account is excluded from totals and reminder mentions:
its phone's vote may not sync to WhatsApp Web. Missing votes from that account are
shown as unknown. Retrieval failures or unmatched voter identities stop reminders.

The daily job uses Windows Task Scheduler, the local equivalent of cron:

```powershell
./scripts/install-hockey-task.ps1
```

This installs `BisonBotDaily` **disabled**, with a **dry-run** action. Its trigger is
9 AM Mountain time, following daylight saving time. It needs this computer awake,
the Windows user signed in, and Whatsapper running at `127.0.0.1:4010`.
Sending requires adding `-Send` to the runner invocation and enabling the job;
neither is done by the installer.

The runner selects every unstarted, non-cancelled game from today through three
calendar days ahead in `America/Edmonton`. Each game is processed independently:

- If no poll exists, create one at the next 9 AM run, including games discovered
  after the usual three-day posting date. Repeated runs reuse the saved poll and
  do not send a reminder on the day a regular poll was created.
- If a poll exists, remind unresolved members two days before and on game day.
  No reminder is due one day before. Overlapping games each get their own reminder.
- In and Out resolve attendance; Beer Guy is an extra role. Game Time Decision
  voters are reminded on game day to switch to In or Out.

Every poll and reminder includes the opponent, full game date, puck-drop time,
and arena. Reminders reply to that game's original poll, so messages about
different games on the same day remain distinguishable.

Live runs are restricted to the 9 AM Mountain hour. No action is sent after puck
drop. The run API defaults to dry-run; sending requires boolean `dryRun: false`.
Changed fixtures, uncertain delivery, and unavailable votes are reported per game
in `errors`, while other games can proceed. The PowerShell runner saves the report
and exits with an error if any game failed. Invalid schedules or duplicate IDs
reject the entire run. Every message carries the Bison Bot disclosure.

The September 30 one-off poll is saved against game `21825` and reused, so the
regular run will not create a second poll for that game. Delivery attempts and
reports are saved in the ignored `data/hockey-bot` directory. Uncertain delivery
is left for review rather than automatically retried.

Docker stores poll state in `/data/hockey-bot` on the existing persistent volume;
Windows uses the project's `data/hockey-bot`. Set `HOCKEY_STATE_DIR` to override.
Keep this state when moving or reinstalling the bot to prevent duplicate polls.
The WhatsApp library is pinned to the version matched by the compatibility patch,
which is also copied and applied during Docker builds.

Run `node --test test/*.test.js` for the regression suite. Tests use a fake WhatsApp
client and never connect to WhatsApp or send real messages. The old agent draft is
historical; this section describes the implemented scheduling rules.
