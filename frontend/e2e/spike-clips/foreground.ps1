# Bring the spike dev app (worktree build of app.exe) to the foreground.
$p = Get-CimInstance Win32_Process -Filter "Name='app.exe'" | Where-Object { $_.ExecutablePath -like '*puca-clips*' } | Select-Object -First 1
if (-not $p) { Write-Output "NO_APP"; exit 2 }
$proc = Get-Process -Id $p.ProcessId
Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
'@ -Name W -Namespace Win32 -ErrorAction SilentlyContinue
$h = $proc.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { Write-Output "NO_WINDOW"; exit 3 }
[Win32.W]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
Start-Sleep -Milliseconds 200
try { Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate($proc.Id) } catch {}
[Win32.W]::SetForegroundWindow($h) | Out-Null
# HWND_TOPMOST then HWND_NOTOPMOST nudges it above the current z-order without leaving it sticky.
[Win32.W]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003) | Out-Null
Start-Sleep -Milliseconds 150
[Win32.W]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0003) | Out-Null
Start-Sleep -Milliseconds 300
Write-Output ("foreground=" + ([Win32.W]::GetForegroundWindow() -eq $h) + " hwnd=" + $h)
