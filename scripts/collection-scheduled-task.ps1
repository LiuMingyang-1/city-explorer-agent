param(
    [string]$Config = "configs/collection.scheduled.json",
    [switch]$Install,
    [switch]$RunOnce
)
$ErrorActionPreference = "Stop"
$workspacePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $workspacePath
$configPath = (Resolve-Path -LiteralPath $Config).Path
$taskConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($taskConfig.schema_version -ne "xian-collection-task/1" -or $taskConfig.mode -ne "supplement") { throw "INVALID_SCHEDULE_CONFIG" }
$nodePath = (Get-Command node -ErrorAction Stop).Source
if ($RunOnce) {
    & $nodePath (Join-Path $PSScriptRoot "collect-task.ts") --config $configPath --backend windows_task_scheduler --live
    exit $LASTEXITCODE
}
# Preview uses the real runtime validator. It does not read API keys or create files.
& $nodePath (Join-Path $PSScriptRoot "collect-task.ts") --config $configPath
if ($LASTEXITCODE -ne 0) { throw "SCHEDULE_CONFIG_VALIDATION_FAILED" }
if (-not $Install) { Write-Output "Preview only. Use -Install explicitly to register this task."; exit 0 }
if (-not $taskConfig.schedule.enabled) { throw "SCHEDULE_DISABLED_ENABLE_CONFIG_FIRST" }
if ($taskConfig.schedule.backend -ne "windows_task_scheduler") { throw "SCHEDULE_BACKEND_MISMATCH" }
$taskName = [string]$taskConfig.schedule.task_name
if ($taskName -notmatch '^[A-Za-z][A-Za-z0-9_-]{0,79}$') { throw "INVALID_TASK_NAME" }
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw "TASK_ALREADY_EXISTS" }
$shellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$scriptPath = $PSCommandPath
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Config "{1}" -RunOnce' -f $scriptPath, $configPath
$action = New-ScheduledTaskAction -Execute $shellPath -Argument $arguments -WorkingDirectory $workspacePath
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ([int]$taskConfig.schedule.poll_minutes))
# Keep the process alive for bounded in-flight requests to finish and release its lock.
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -Hidden
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "City Explorer local collection; business time and engines are read from JSON each tick."
