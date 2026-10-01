param(
    [switch]$DryRun,
    [switch]$Send,
    [Alias('Date')][string]$AsOf,
    [string]$SchedulePath = (Join-Path $PSScriptRoot '..\schedule.csv')
)

$ErrorActionPreference = 'Stop'
if ($Send -and ($DryRun -or $AsOf)) { throw '-Send cannot be combined with -DryRun or a test date.' }
$taskRunAt = [DateTimeOffset]::UtcNow
if ($AsOf) {
    # A calendar date means 9 AM Mountain time on that date, including DST.
    if ($AsOf -notmatch '^\d{4}-\d{2}-\d{2}$') { throw '-Date expects YYYY-MM-DD.' }
    $taskLocalDate = [DateTime]::ParseExact($AsOf, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture).AddHours(9)
    $taskLocalDate = [DateTime]::SpecifyKind($taskLocalDate, [DateTimeKind]::Unspecified)
    $taskZone = [TimeZoneInfo]::FindSystemTimeZoneById('Mountain Standard Time')
    $taskRunAt = [DateTimeOffset]::new($taskLocalDate, $taskZone.GetUtcOffset($taskLocalDate))
}
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location $taskRoot
$taskRows = @(Import-Csv -LiteralPath $SchedulePath)
if ($taskRows.Count -eq 0) { throw 'The schedule CSV is empty.' }
$taskIds = @{}
$taskGames = @($taskRows | ForEach-Object {
    if ($_.game_id -notmatch '^\d+$' -or $taskIds.ContainsKey($_.game_id)) { throw 'Invalid or duplicate game ID.' }
    if ($_.cancelled -notin @('true', 'false')) { throw 'cancelled must be true or false.' }
    $taskIds[$_.game_id] = $true
    @{
        id = $_.game_id
        start = $_.start
        opponent = $_.opponent
        arena = $_.arena
        cancelled = $_.cancelled -eq 'true'
    }
})

# Safe default: inspect the plan and existing poll. Sending requires -Send explicitly.
$taskPayloadData = @{
    games = $taskGames
    dryRun = -not $Send
    scheduleReadAt = [DateTimeOffset]::UtcNow.ToString('o')
}
if ($AsOf) { $taskPayloadData.asOf = $taskRunAt.ToString('o') }
$taskPayload = $taskPayloadData | ConvertTo-Json -Depth 8
$taskResult = Invoke-RestMethod -Uri 'http://127.0.0.1:4010/hockey/run' -Method Post -ContentType 'application/json' -Body $taskPayload -TimeoutSec 120
$taskReport = @{ checkedAt = [DateTimeOffset]::UtcNow.ToString('o'); asOf = $taskRunAt.ToString('o'); dryRun = -not $Send; plan = $taskResult }

$taskLogRoot = Join-Path $taskRoot 'data\hockey-bot\reports'
New-Item -ItemType Directory -Force -Path $taskLogRoot | Out-Null
$taskReport | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $taskLogRoot 'latest-run.json') -Encoding UTF8
foreach ($taskFailure in $taskResult.errors) {
    Write-Warning ('Game ' + $taskFailure.gameId + ': ' + $taskFailure.error)
}
if (-not $Send) {
    Write-Output ('DRY RUN for ' + $taskRunAt.ToString('yyyy-MM-dd HH:mm zzz') + ' - nothing will be sent.')
    Write-Output 'Previews use current poll votes, including when testing a future date.'
    $taskOutgoing = @($taskResult.plans | Where-Object { $_.willSend })
    Write-Output ("`nMessages/polls planned: " + $taskOutgoing.Count)
    if ($taskOutgoing.Count -eq 0) { Write-Output 'No messages or polls planned for successfully checked games.' }
    foreach ($taskPlan in $taskResult.plans) {
        Write-Output ("`n--- " + $taskPlan.action.ToUpper() + ' for game ' + $taskPlan.game.id + ' - BISONS ---')
        if (-not $taskPlan.willSend) { Write-Output $taskPlan.reason; continue }
        if ($taskPlan.message.type -eq 'poll') {
            Write-Output $taskPlan.message.title
            Write-Output "`nPoll options:"
            foreach ($taskOption in $taskPlan.message.options) { Write-Output ('- ' + $taskOption) }
            Write-Output ('Multiple answers allowed: ' + $taskPlan.message.allowMultipleAnswers)
        } else {
            Write-Output $taskPlan.message.text
            Write-Output "`nPeople mentioned:"
            foreach ($taskRecipient in $taskPlan.recipients) {
                Write-Output ('- ' + $taskRecipient.name + ' (' + $taskRecipient.reason + ')')
            }
            Write-Output 'This message replies to the original poll.'
        }
    }
} else {
    $taskResult | ConvertTo-Json -Depth 8
}
if ($taskResult.errors.Count -gt 0) { throw 'Some games could not be processed. See the warnings and data/hockey-bot/reports/latest-run.json.' }
