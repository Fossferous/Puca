# End-to-end verification of the host agent over a REAL named pipe.
#
# Proves the claim the whole agent exists for: a screen frame captured with NO
# user gesture, NO picker and NO window -- which getDisplayMedia structurally
# cannot do. Also proves the pipe refuses unauthenticated and mis-authenticated
# callers, because "local" includes every other process on the machine and this
# thing injects OS input.
#
#   cargo build -p puca-agent
#   powershell -ExecutionPolicy Bypass -File crates/puca-agent/verify-agent.ps1
$ErrorActionPreference = 'Stop'

# The crate is a workspace member, so cargo writes to the WORKSPACE target
# dir, not this folder's. Asked, not assumed: a leftover binary under the old
# path would run all of the checks below against an older commit and report
# every one of them passing.
$wsRoot = Split-Path (cargo locate-project --workspace --message-format plain)
$agent = Join-Path $wsRoot 'target\debug\puca-agent.exe'
if (-not (Test-Path $agent)) { throw "build it first: cargo build -p puca-agent" }

$pipeName = "puca-agent-verify-$PID"
$full = '\\.\pipe\' + $pipeName
$p = Start-Process -FilePath $agent -ArgumentList '--token', 'test-token-1234567890', '--pipe', $full -PassThru -WindowStyle Hidden

# Wait for the PIPE to appear rather than sleeping a guessed interval. A fixed
# sleep is the classic source of a test that passes on one machine and times out
# on a slower one -- and the timeout then reads as a broken agent, which it isn't.
$ready = $false
foreach ($i in 1..50) {
    if ($p.HasExited) { throw "agent exited immediately (code $($p.ExitCode))" }
    if ([System.IO.Directory]::GetFiles('\\.\pipe\') -contains $full) { $ready = $true; break }
    Start-Sleep -Milliseconds 200
}
if (-not $ready) { Stop-Process -Id $p.Id -Force -EA SilentlyContinue; throw "agent never created $full" }

$script:fail = 0
$script:ran = 0
function Check($name, $cond, $detail) {
    $script:ran++
    if ($cond) { Write-Host "PASS  $name" }
    else { Write-Host "FAIL  $name  --  $detail"; $script:fail++ }
}

# How many checks this file DEFINES. Compared against how many actually ran, so
# a check that is silently skipped cannot pass as success.
#
# This is not hypothetical: an em-dash in a BOM-less .ps1 made Windows
# PowerShell 5.1 (which reads it as ANSI) swallow the FOLLOWING line, so one
# check vanished while the script still reported ALL PASS. Non-ASCII is now
# banned from this file, and this guard catches the next way it happens.
$script:expected = (Select-String -Path $PSCommandPath -Pattern '^\s*Check ').Count

try {
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(5000)
    $sw = New-Object System.IO.StreamWriter($pipe); $sw.AutoFlush = $true
    $sr = New-Object System.IO.StreamReader($pipe)
    function Send($json) { $sw.WriteLine($json); return $sr.ReadLine() }

    Check "an unauthenticated command is refused" `
        ((Send '{"cmd":"capabilities"}') -match 'not authenticated') "the pipe served an unauthenticated caller"

    # "not authenticated", not "bad token": the agent answers a wrong token with
    # the SAME message as a missing one, deliberately, so a caller learns nothing
    # about which it got wrong. This check spelled it "bad token" and had been
    # reporting FAIL against correct, constant-time-comparing code -- a security
    # check that cries wolf is one people learn to scroll past.
    Check "a wrong token is refused" `
        ((Send '{"cmd":"hello","token":"wrong-token-000000000","version":2}') -match 'not authenticated') "a bad token was accepted"

    Check "a protocol mismatch is refused rather than guessed" `
        ((Send '{"cmd":"hello","token":"test-token-1234567890","version":999}') -match 'protocol mismatch') "a mismatched version was accepted"

    Check "the correct token authenticates" `
        ((Send '{"cmd":"hello","token":"test-token-1234567890","version":2}') -match '"ok":"hello"') "the right token was refused"

    $caps = Send '{"cmd":"capabilities"}'
    Check "capture and UNATTENDED are reported" `
        ($caps -match '"capture":true' -and $caps -match '"unattended":true') $caps
    Check "elevation is NOT overclaimed" `
        ($caps -match '"elevated":false') "claimed UAC/lock-screen support it does not have"

    $started = Send '{"cmd":"start_capture","session_id":"s1","monitor":0}'
    Check "capture starts with no gesture and no picker" ($started -match '"ok":"started"') $started
    $w = [int]([regex]::Match($started, '"width":(\d+)').Groups[1].Value)
    $h = [int]([regex]::Match($started, '"height":(\d+)').Groups[1].Value)
    Check "the reported dimensions are real" ($w -gt 0 -and $h -gt 0) "got ${w}x${h}"

    $frame = ''
    foreach ($i in 1..20) {
        $frame = Send '{"cmd":"next_frame","session_id":"s1","timeout_ms":500}'
        if ($frame -match '"ok":"frame"') { break }
    }
    Check "a real frame arrives" ($frame -match '"ok":"frame"') "no frame after 20 attempts"

    $b64 = [regex]::Match($frame, '"bgra":"([^"]*)"').Groups[1].Value
    Check "the frame carries actual pixel data" ($b64.Length -gt 1000) "payload was $($b64.Length) chars"
    # A stub returning zeroes encodes as one repeated character; real pixels vary.
    # "a frame was returned" would pass on a blank buffer, so assert variation.
    $sample = $b64.Substring(0, [Math]::Min(4000, $b64.Length))
    Check "the pixels are not a uniform stub" `
        ((($sample.ToCharArray() | Sort-Object -Unique).Count) -gt 8) "payload looks uniform"

    # --- the streaming path: a real browser-shaped offer, answered ---
    $offer = @(
        'v=0','o=- 1 1 IN IP4 127.0.0.1','s=-','t=0 0','a=group:BUNDLE 0',
        'm=video 9 UDP/TLS/RTP/SAVPF 102','c=IN IP4 0.0.0.0','a=rtcp-mux',
        'a=ice-ufrag:abcd','a=ice-pwd:efghijklmnopqrstuvwx',
        ('a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:' +
         '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF'),
        'a=setup:actpass','a=mid:0','a=recvonly','a=rtpmap:102 H264/90000',
        'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f'
    ) -join "`r`n"
    $offerJson = ($offer | ConvertTo-Json)
    # 6_000_000, because the agent validates bitrate against ALLOWED_BITRATE_BPS
    # ([1M, 3M, 6M, 10M]) and this asked for 2M -- which it has never accepted. The
    # start therefore failed, and FOUR later checks failed as consequences of it:
    # no answer to inspect, and a "duplicate stream" that was really the first one
    # succeeding. One stale number, five red lines.
    $streamed = Send ('{"cmd":"start_stream","session_id":"rtc1","monitor":1,"offer_sdp":' + $offerJson + ',"fps":15,"bitrate":6000000}')
    Check "a browser-shaped offer is answered" ($streamed -match '"ok":"streaming"') $streamed
    $answer = [regex]::Match($streamed, '"answer_sdp":"([^"]*)"').Groups[1].Value
    Check "the answer carries video" ($answer -match 'm=video') "no m=video in the answer"
    Check "the answer keeps H.264" ($answer -match 'H264') "H.264 was dropped -- the peer would connect and decode nothing"
    Check "the answer advertises an ICE candidate" ($answer -match 'a=candidate') "no candidate -- the peer would have nothing to connect to"
    Check "a second stream on the same session is refused" `
        ((Send ('{"cmd":"start_stream","session_id":"rtc1","monitor":1,"offer_sdp":' + $offerJson + '}')) -match 'already streaming') "a duplicate stream was allowed"
    Check "input is accepted for a streaming session" `
        ((Send '{"cmd":"inject","session_id":"rtc1","event":{"t":"wheel","dy":0}}') -match '"ok":"ok"') "input was refused for a live stream"
    Check "the stream stops cleanly" ((Send '{"cmd":"stop_stream","session_id":"rtc1"}') -match '"ok":"ok"') "stop_stream failed"

    # --- files without a screen -------------------------------------------
    #
    # A data-only stream answers the same offer and opens the same channels
    # without ever acquiring the duplication. The filesystem operations
    # themselves ride the WebRTC data channel rather than this pipe, so what is
    # verifiable HERE is the control plane: that such a session starts, that a
    # scope can be granted and taken away, and -- the property that matters --
    # that a session with no screen cannot drive one.
    $dataOnly = Send ('{"cmd":"start_stream","session_id":"files1","monitor":0,"offer_sdp":' + $offerJson + ',"data_only":true}')
    Check "a data-only stream is answered without capturing" ($dataOnly -match '"ok":"streaming"') $dataOnly

    Check "the unattended policy scope can be granted" `
        ((Send '{"cmd":"set_file_access","session_id":"files1","policy":true}') -match '"ok":"ok"') "the policy scope was refused"

    Check "a folder AND the policy at once is refused rather than widened" `
        ((Send '{"cmd":"set_file_access","session_id":"files1","root":"C:\\","policy":true}') -match 'ambiguous') "an ambiguous scope was resolved instead of refused"

    Check "file access can be revoked" `
        ((Send '{"cmd":"set_file_access","session_id":"files1"}') -match '"ok":"ok"') "revoke was refused"

    Check "granting access to a session with no stream is refused" `
        ((Send '{"cmd":"set_file_access","session_id":"ghost","policy":true}') -match 'no live stream') "a scope was granted for a session that does not exist"

    # The control for the next two is "input is accepted for a streaming session"
    # above: the rig demonstrably CAN drive injection and privacy on a session
    # that has a screen, so these refusals are about not having one.
    Check "a data-only session cannot inject input" `
        ((Send '{"cmd":"inject","session_id":"files1","event":{"t":"move","x":0.5,"y":0.5}}') -match 'no such capture session') "a session with no screen could move the pointer"

    Check "a data-only session cannot blank the screen" `
        ((Send '{"cmd":"set_privacy_mode","session_id":"files1","enabled":true}') -match 'no live session') "a session with no screen could blank one"

    Check "a data-only session cannot switch monitors" `
        ((Send '{"cmd":"set_monitor","session_id":"files1","monitor":1}') -match 'no screen') "a session with no screen accepted a monitor switch"

    Check "the data-only stream stops cleanly" `
        ((Send '{"cmd":"stop_stream","session_id":"files1"}') -match '"ok":"ok"') "stop_stream failed for a data-only session"

    Check "injection is refused for an unknown session" `
        ((Send '{"cmd":"inject","session_id":"nope","event":{"t":"move","x":0.5,"y":0.5}}') -match 'no such capture session') "a stale session could inject"

    Check "stop succeeds" ((Send '{"cmd":"stop_capture","session_id":"s1"}') -match '"ok":"ok"') "stop failed"
    $pipe.Dispose()
}
finally {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
}

if ($script:ran -ne $script:expected) {
    Write-Host "`nINCOMPLETE: $($script:ran) checks ran but $($script:expected) are defined."
    Write-Host "A check was skipped -- treat this as a failure, not a pass."
    exit 1
}
if ($script:fail -gt 0) { Write-Host "`n$($script:fail) FAILURE(S)"; exit 1 }
Write-Host "`n$($script:ran)/$($script:expected) checks ran, ALL PASS"
exit 0
