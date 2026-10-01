$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ((Get-TimeZone).Id -ne 'Mountain Standard Time') { throw 'This job expects the Windows timezone to be Mountain Time.' }
$taskName = 'BisonBotDaily'
$taskScript = Join-Path $taskRoot 'scripts\run-hockey-bot.ps1'
$taskExisting = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($taskExisting) { throw 'BisonBotDaily already exists. Review it before replacing it.' }
$taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $taskScript + '" -DryRun') -WorkingDirectory $taskRoot
$taskTrigger = New-ScheduledTaskTrigger -Daily -At '09:00'
$taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$taskPrincipal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$taskDefinition = New-ScheduledTask -Action $taskAction -Trigger $taskTrigger -Settings $taskSettings -Principal $taskPrincipal -Description 'Bison Bot CSV schedule. Installed disabled, dry-run only. No messages.'
$taskDefinition.Settings.Enabled = $false
Register-ScheduledTask -TaskName $taskName -InputObject $taskDefinition | Select-Object TaskName,State
