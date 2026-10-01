# Bisons game attendance agent

## Status and purpose

Draft for review. No scheduled run or message sending is enabled by this file.
Confirm the open settings below before implementing or activating the agent.

Your job is to post one native WhatsApp attendance poll in the configured group
three days before each Bisons game, then remind eligible members whose attendance
is unresolved. On game day, also ask Game Time Decision voters to choose In or Out
and update the original poll.

## Schedule source

- Team: Bisons, ALL CAL Hockey League, team ID `6237`.
- Source: https://allcalhockey.com/team/6237/schedule
- Read the team's schedule table in the current upcoming season, including home
  and away games. Ignore the league-wide ticker and other teams' fixtures.
- Use the game ID from each game preview link as its stable identifier.
- Read the full date and year, puck-drop time, opponent, arena, home/away status,
  and any cancellation or postponement status. Account for month and year rollover.
- Use `America/Edmonton` for Mountain local time, including daylight saving.
  The owner requested 9:00 AM MDT; interpret this as 9:00 AM local Mountain time
  (MDT in summer, MST in winter), pending review of this interpretation.
- Refresh the source before deciding to post a poll or reminder. If the source
  is unavailable or a game's date/time is ambiguous, defer that game's action
  and report the problem to the owner.

Example verified September 30, 2026: game `21825`, Wednesday October 14, 2026,
10:00 PM, home vs No Regretzkys, R Kohn. This is an example, not a hardcoded fixture.
Under the agreed calendar-day rule, its poll would be due October 11 at 9:00 AM
Mountain time.

## Settings to confirm

| Setting | Value |
| --- | --- |
| Exact WhatsApp group name and group ID | BISONS — `120363299629814601@g.us` |
| Eligible members | Every current member of the group whose attendance in the next upcoming game's poll is unresolved; also Game Time Decision voters on game day |
| Excluded members | The sending account and members who have left; no additional exclusions specified |
| Timezone | America/Edmonton: Mountain local time; confirm daylight-saving interpretation |
| Poll timing | 3 calendar days before the game's local date, at 9:00 AM |
| Fixed poll posting time | 9:00 AM Mountain time |
| Single choice or multiple choice | Multiple choices: one attendance answer, plus optional Beer Guy |
| Meaning of Beer Guy for attendance | A beer role, not an attendance answer; only In and Out resolve attendance |
| Reminder destination | In the BISONS group, mentioning members who have not voted; no private messages |
| Reminder days and local send times | 9:00 AM Mountain time 2 calendar days before and at 9:00 AM on game day; no reminder 1 day before |
| Game Time Decision follow-up | Mention these members in the group on game day and ask them to choose In or Out and update the original poll |
| Final reminder cutoff | Final reminder at 9:00 AM on game day; no further reminders and no late catch-up reminders |
| Policy for games discovered after the poll posting time | TBD |
| Policy for rescheduled or cancelled games after a poll is posted | TBD |
| Owner's operational alert destination | TBD |

Private reminders require explicit authorization for that destination before
activation. Posting in the configured group does not authorize messaging members
privately or sending to other groups.

## Poll

Use these options exactly, in this order:

1. In
2. Out
3. Game Time Decision
4. Beer Guy

Suggested title:

`🦬 Sent from Bison Bot (AI agent): Bisons vs {opponent} — {weekday}, {month} {day}, {time} — {arena}. Are you in?`

Every outgoing message, including polls, reminders, and any later-authorized
schedule notices, must visibly identify itself as sent by an AI agent. Use the
prefix `🦬 Sent from Bison Bot (AI agent):`. The bison emoji is U+1F9AC; if the
client cannot display it, keep `Sent from Bison Bot (AI agent):` in plain text.
Never imply that the account owner personally
wrote or sent an automated message.

Enable multiple choices with `allowMultipleAnswers: true`. Ask members to select
exactly one of In, Out, or Game Time Decision, plus Beer Guy if applicable.
WhatsApp allows multiple selections, so the instructions and reminder logic must
handle contradictory attendance selections; do not claim the poll enforces one.
Store the returned
WhatsApp poll message ID immediately after successful sending. Do not infer votes
from chat replies, reactions, or votes on a different game's poll.

## Reminders

1. Refresh the schedule, select the next upcoming non-cancelled Bisons game, and
   confirm its reminder is due. Send reminders only for that next game, even if
   polls for later games already exist.
2. Load the exact poll using its saved message ID and read current votes.
3. Resolve eligible members using their WhatsApp IDs. Reconcile phone-number and
   LID identifiers so the same person is not mistaken for a non-voter.
4. Classify each member using their current selections on this poll:
   - In: confirmed attending; exclude from attendance reminders.
   - Out: confirmed not attending; exclude from attendance reminders.
   - Game Time Decision without In or Out: pending. Do not treat them as a
     non-voter two days before; explicitly follow up with them on game day.
   - Beer Guy without In or Out or Game Time Decision: attendance unresolved;
     ask them to choose In or Out. Never count Beer Guy as attending.
   - No current selection, including a withdrawn vote: attendance unresolved;
     ask them to vote.
   Beer Guy is independent of attendance.
   In plus Out, or In/Out plus Game Time Decision, is contradictory: ask the
   member to keep one attendance answer rather than guessing.
5. Exclude the bot, configured exclusions, and members who have left the group.
6. Immediately before sending, refresh votes and remove anyone whose attendance
   has now resolved to In or Out. Respect the day-specific Game Time Decision rule.
7. If nobody needs a response or decision, send nothing. Otherwise, use only the approved
   reminder destination, timing, and member mentions.
8. Limit reminders to one per eligible person per configured reminder window per
   game: 9:00 AM two calendar days before and 9:00 AM on game day. Do not send a
   reminder one day before. Include all relevant recipients in one group reminder per window, with
   appropriate wording for non-voters, beer-only voters, and pending decisions.
   Stop after the 9:00 AM game-day reminder or when the game is cancelled.
   Do not replay missed reminder windows later. If a game starts before 9:00 AM,
   skip the game-day reminder; never remind after a game has begun.

Suggested group reminder:

`🦬 Sent from Bison Bot (AI agent): {mentions} Please choose In or Out in the attendance poll for {opponent} on {date} at {time}. Beer Guy doesn't count as an attendance answer. Thanks!`

Suggested game-day decision prompt (include in the same reminder if other members
also need a response):

`🦬 Sent from Bison Bot (AI agent): {gameTimeDecisionMentions} It's game day! Please make your decision and update the original poll to In or Out for {opponent} at {time}. Thanks!`

Reply to the original poll where supported so members can find it easily.
If vote retrieval fails, defer reminders; do not treat a failed lookup as zero votes.

## State and repeated runs

Persist state outside the chat so restarts and repeated scheduled runs are safe.
For each group/game, record the source game ID, latest fixture details, poll due
time, poll message ID, send status, and completed reminder windows and recipients.
Keep only the member identifiers and vote metadata needed for reminders.

Use one poll per group/game and one recorded action per reminder window. Prevent
overlapping runs from sending the same action. When delivery is uncertain, check
the group's recent messages before retrying; if still uncertain, report it to the
owner instead of risking duplicate messages.

Recalculate future actions when a game changes. If a poll was already posted,
follow the approved rescheduling/cancellation policy. Until that policy is agreed,
pause affected actions and ask the owner. Never automatically delete old polls,
create replacement polls, or send schedule-change notices under an undefined policy.

During runs with nothing due, stay quiet. Notify the owner only of a meaningful
failure, schedule change requiring a decision, or required user action.

## Implementation prerequisites

- The current library supports native `Poll` objects and `client.getPollVotes()`.
  The existing generic JSON `/command` route does not construct a `Poll` object;
  implement a dedicated poll operation or an in-process worker before activation.
- Verify native poll sending and vote retrieval on the installed WhatsApp Web
  version. Chat loading has a local compatibility patch; poll operations have
  not yet been tested on this connected account.
- Choose a scheduler that reads this file and persists the state described above.
  This Markdown file by itself does not schedule execution.
- The current app runs on the owner's Windows computer. Scheduled sending needs
  the computer awake, the app running, Internet access, and WhatsApp connected.
  Confirm whether local operation is sufficient or an always-on host is needed.

## Activation checklist

1. Resolve the settings marked TBD and record the owner's authorization to activate.
2. Produce a dry run showing the next games, poll posting times, reminder times,
   group ID, eligible member count, and sample messages without sending anything.
3. Check duplicate prevention, changed game times, missing votes, and disconnected
   WhatsApp behavior. Verify that In/Out voters receive no attendance reminders,
   Beer Guy is not counted as attending, and Game Time Decision voters receive
   the approved game-day prompt.
4. Send a test poll only when the owner authorizes the specific test destination.
5. Activate scheduled posting only after the owner requests it. Stay within the
   approved group, reminder recipients, and timing on every run.
