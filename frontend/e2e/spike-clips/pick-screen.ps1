# UI Automation helper for the Chromium/WebView2 "Choose what to share" picker.
#   pick-screen.ps1 -Dump              # list top-level windows + the picker's controls
#   pick-screen.ps1 -Pick "Screen 3"   # select that source, tick system audio, press Share
# Used only by the Phase 0 clip spike when --auto-select-desktop-capture-source
# does not take effect (three monitors here => sources are "Screen 1..3").
param(
    [switch]$Dump,
    [string]$Pick = "",
    [int]$WaitSeconds = 60
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$ae = [System.Windows.Automation.AutomationElement]
$root = $ae::RootElement

function Find-Picker {
    $cond = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
    $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
    foreach ($w in $wins) {
        $name = $w.Current.Name
        if ($name -match 'share|Choose|Puca|screen' ) {
            # The picker is a Chromium views dialog; its descendants include the source tiles.
            $desc = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
            $hasScreen = $false
            foreach ($d in $desc) { if ($d.Current.Name -match '^Screen \d|Entire screen') { $hasScreen = $true; break } }
            if ($hasScreen) { return $w }
        }
    }
    return $null
}

function Dump-Element($el, $depth) {
    $c = $el.Current
    if ($c.Name -or $c.ControlType.ProgrammaticName -match 'CheckBox|Button|ListItem|RadioButton|Tab') {
        Write-Output (("  " * $depth) + "[$($c.ControlType.ProgrammaticName -replace 'ControlType.','')] '$($c.Name)' cls=$($c.ClassName) enabled=$($c.IsEnabled) rect=$($c.BoundingRectangle)")
    }
    $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($k in $kids) { Dump-Element $k ($depth + 1) }
}

function Click-Element($el) {
    $ip = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) { $ip.Invoke(); return "invoked" }
    $sp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sp)) { $sp.Select(); return "selected" }
    # Fall back to a real mouse click at the element's centre.
    $r = $el.Current.BoundingRectangle
    $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
    Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.UIntPtr dwExtraInfo);
'@ -Name Mouse -Namespace Win32 -ErrorAction SilentlyContinue
    [Win32.Mouse]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 100
    [Win32.Mouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [Win32.Mouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    return "clicked@$x,$y"
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$picker = $null
while (-not $picker -and (Get-Date) -lt $deadline) { $picker = Find-Picker; if (-not $picker) { Start-Sleep -Milliseconds 700 } }
if (-not $picker) {
    if ($Dump) {
        Write-Output "No picker found. Top-level windows:"
        $cond = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
        foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) { Write-Output " - '$($w.Current.Name)' cls=$($w.Current.ClassName)" }
    } else { Write-Output "NO_PICKER" }
    exit 2
}
Write-Output "PICKER '$($picker.Current.Name)' cls=$($picker.Current.ClassName)"
if ($Dump) { Dump-Element $picker 0; exit 0 }
if ($Pick) {
    # The dialog opens on the "Window" tab; screens live under "Entire Screen".
    $all = $picker.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($d in $all) {
        if ($d.Current.Name -eq 'Entire Screen' -and $d.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem) {
            Write-Output ("tab: " + (Click-Element $d)); Start-Sleep -Milliseconds 800; break
        }
    }
    $all = $picker.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $tile = $null; $firstScreen = $null; $audio = $null; $share = $null
    foreach ($d in $all) {
        $n = $d.Current.Name
        $isBtn = $d.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button
        if (-not $tile -and $n -eq $Pick -and $isBtn) { $tile = $d }
        if (-not $firstScreen -and $n -match '^(Screen \d+|Entire screen)$' -and $isBtn) { $firstScreen = $d }
        if (-not $audio -and $n -match 'audio' -and $isBtn -and $d.Current.ClassName -match 'Toggle') { $audio = $d }
        if (-not $audio -and $n -match 'audio' -and $d.Current.ControlType -eq [System.Windows.Automation.ControlType]::CheckBox) { $audio = $d }
        if (-not $share -and $n -eq 'Share' -and $isBtn) { $share = $d }
    }
    if (-not $tile) { $tile = $firstScreen }
    if (-not $tile) { Write-Output "NO_TILE '$Pick'"; Dump-Element $picker 0; exit 3 }
    Write-Output ("tile name: '" + $tile.Current.Name + "'")
    Write-Output ("tile: " + (Click-Element $tile))
    Start-Sleep -Milliseconds 400
    if ($audio) {
        $tp = $null
        if ($audio.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tp)) {
            Write-Output ("audio state: " + $tp.Current.ToggleState)
            if ($tp.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) { $tp.Toggle(); Write-Output "audio toggled on" }
        } else { Write-Output ("audio: " + (Click-Element $audio)) }
    } else { Write-Output "NO_AUDIO_CHECKBOX" }
    Start-Sleep -Milliseconds 300
    if ($share) { Write-Output ("share: " + (Click-Element $share)) } else { Write-Output "NO_SHARE_BUTTON" }
    exit 0
}
