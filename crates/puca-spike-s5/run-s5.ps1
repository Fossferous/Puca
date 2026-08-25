# Spike S5 runner.
#
# Answers the question the plan says decides whether Phase 8 is a sprint or a
# quarter: can a SYSTEM process follow the input desktop onto Winlogon, and
# capture it?
#
# MUST be run from an ELEVATED PowerShell (it creates a scheduled task running
# as SYSTEM). Nothing here is installed permanently: the task is deleted at the
# end, in a finally block so it goes even if the run is interrupted.
#
#   powershell -ExecutionPolicy Bypass -File run-s5.ps1
#
# The task lands in SESSION 0. The spike now detects that and RELAUNCHES itself
# into the interactive console session on winsta0\default (the exact mechanism
# the real service will use) — the earlier version failed because a session-0
# process has no input desktop at all and OpenInputDesktop returned 0x80070001
# before UAC was ever relevant.
#
# When it says GO, trigger a UAC prompt. Because THIS PowerShell is elevated,
# elevating from here will NOT prompt — trigger it from a NORMAL window instead
# (the script prints the exact command).
$ErrorActionPreference = 'Stop'

# Prefer a release build if present; fall back to debug.
$release = Join-Path $PSScriptRoot 'target\release\spike-s5.exe'
$debug   = Join-Path $PSScriptRoot 'target\debug\spike-s5.exe'
$exe = if (Test-Path $release) { $release } elseif (Test-Path $debug) { $debug } else {
    throw "build it first: cargo build -p puca-spike-s5  (looked for release then debug)"
}
Write-Host "using: $exe"

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "This must run from an ELEVATED PowerShell."
    Write-Host "Right-click PowerShell -> Run as administrator, then re-run this script."
    exit 2
}

# --- Precheck 1: a user must be logged in at the physical console, or there is
#     no interactive session to relaunch into and the spike stays on session 0. ---
$consoleUser = (Get-CimInstance Win32_ComputerSystem).UserName
if ([string]::IsNullOrWhiteSpace($consoleUser)) {
    Write-Host ""
    Write-Host "WARNING: no interactive console user is logged in. The relaunch needs an"
    Write-Host "active console session; without one the spike cannot leave session 0."
    Write-Host "Log in at the physical console (not RDP) and re-run."
} else {
    Write-Host "console user: $consoleUser"
}

# --- Precheck 2: if the secure desktop is disabled by policy, UAC prompts render
#     on Default and the input desktop never switches to Winlogon — a false
#     'never exercised' that has nothing to do with the spike. ---
$psd = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' `
        -Name PromptOnSecureDesktop -ErrorAction SilentlyContinue).PromptOnSecureDesktop
if ($null -ne $psd -and $psd -eq 0) {
    Write-Host ""
    Write-Host "WARNING: PromptOnSecureDesktop = 0. UAC prompts will appear on the DEFAULT"
    Write-Host "desktop, not Winlogon, so 'saw the Winlogon desktop' will be false for a"
    Write-Host "non-security reason. Set it to 1 to test the real secure-desktop path."
} else {
    Write-Host "PromptOnSecureDesktop: $psd (1 or unset = secure desktop active)"
}

# C:\Users\Public, NOT the per-user %TEMP%: the SYSTEM session-0 process could not
# write under a user's temp, so the first run produced no log at all. Public is
# writable by SYSTEM and readable by the user. (The spike also self-falls-back to
# this path, but pointing here directly keeps the two in agreement.)
$log = 'C:\Users\Public\s5-system.log'
if (Test-Path $log) { Remove-Item $log -Force }
$task = 'PucaSpikeS5'
$seconds = 90

try {
    # /ru SYSTEM is the whole point: the ordinary-user baseline already showed
    # Winlogon is unreachable without it. The task starts in session 0; the
    # spike relaunches itself into the console session from there.
    # /ST a couple of minutes ahead only to avoid the cosmetic "earlier than
    # current time" warning; we start it immediately with /run regardless.
    $st = (Get-Date).AddMinutes(2).ToString('HH:mm')
    schtasks /create /tn $task /tr "`"$exe`" --log `"$log`" --seconds $seconds" `
             /sc once /st $st /ru SYSTEM /rl HIGHEST /f | Out-Null
    schtasks /run /tn $task | Out-Null

    Write-Host ""
    Write-Host "  GO -- trigger a UAC prompt now. In a NON-elevated window (Win+R, or a"
    Write-Host "  normal PowerShell), run:"
    Write-Host ""
    Write-Host "      Start-Process notepad -Verb RunAs"
    Write-Host ""
    Write-Host "  or right-click any app -> Run as administrator. You can CANCEL the"
    Write-Host "  prompt; the spike only needs the secure desktop to appear. (Elevating"
    Write-Host "  from THIS elevated window will NOT prompt.)"
    Write-Host ""

    # Poll the task rather than sleeping a fixed time: the session-0 parent waits
    # for its interactive child, so the task stays 'Running' until the child's
    # log is complete. Reading only once it goes 'Ready' avoids racing the log.
    $deadline = (Get-Date).AddSeconds($seconds + 25)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        $status = (schtasks /query /tn $task /fo list 2>$null | Select-String '^Status:')
        $remain = [int]($deadline - (Get-Date)).TotalSeconds
        Write-Host "  ...$remain s left   ($($status -replace '\s+',' '))"
        if ($status -match 'Ready') { break }
    }

    # Capture the task's own verdict BEFORE deleting it, so an empty log still
    # tells us whether the exe ran and with what exit code. "Last Result" is the
    # process exit code (0 = clean; 0xC000013A = Ctrl-break/kill; 0x1 = our
    # exit(2) non-Windows guard; a big 0xC-code = a crash).
    Write-Host ""
    Write-Host "=== TASK STATUS (exit code / last run) ==="
    schtasks /query /tn $task /fo LIST /v 2>$null |
        Select-String 'Last Run Time:|Last Result:' | ForEach-Object { $_.ToString().Trim() }

    Write-Host ""
    Write-Host "=== SYSTEM RUN RESULT ==="
    if (Test-Path $log) {
        Get-Content $log
    } else {
        Write-Host "no log at $log"
        # The spike falls back to a path beside the exe if even Public failed;
        # check there before concluding the exe never ran.
        $beside = Join-Path (Split-Path $exe) 's5-system.log'
        if (Test-Path $beside) {
            Write-Host "--- found fallback log beside the exe: $beside ---"
            Get-Content $beside
        } else {
            Write-Host "no fallback log at $beside either -- see the exit code above."
        }
    }
}
finally {
    schtasks /delete /tn $task /f 2>$null | Out-Null
    Write-Host ""
    Write-Host "(scheduled task removed)"
}
