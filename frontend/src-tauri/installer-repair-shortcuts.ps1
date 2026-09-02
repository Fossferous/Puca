# Repair shortcuts and taskbar pins that still point at a binary this install
# no longer has.
#
# WHY. 0.9.0 renamed the executable (app.exe -> Puca.exe / Puca-Lite.exe). NSIS
# rewrites the Start Menu and desktop shortcuts it created, but a taskbar pin is
# a shortcut the USER made, in a folder the installer never touches, and it kept
# pointing at app.exe: clicking it said the item had been moved. Switching
# between the Full and Lite variants leaves the same wound (the other variant's
# binary is gone). And the Sovereign-era desktop shortcut still targets a
# folder that was migrated in place months ago.
#
# WHAT IT DOES. For every .lnk in the user's Start Menu, desktop, taskbar-pin and
# Start-pin folders whose target is (a) an app.exe / Puca.exe / Puca-Lite.exe
# that no longer exists and (b) inside a Puca, Puca Lite or Sovereign install
# folder, retarget it to this install's binary. Nothing that still resolves is
# touched; nothing outside those folders is read. A stale Sovereign.lnk is
# removed when a Puca shortcut already sits beside it.
#
# Run by the NSIS post-install hook (installer-migrate.nsh) with the install
# directory and the new binary name; exit code 0 always — a repair that fails
# must never fail the install.
param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$Binary,
    # TESTS ONLY: the folders to scan. When given, the user's real profile is
    # never resolved — Desktop comes from the registry, not from USERPROFILE,
    # so an override of the environment is not enough to keep a test off it.
    [string[]]$Roots
)
$ErrorActionPreference = 'Continue'
$newTarget = Join-Path $InstallDir $Binary
if (-not (Test-Path -LiteralPath $newTarget)) { Write-Output "repair-shortcuts: $newTarget is not installed; nothing to do"; exit 0 }

$oldBinaries = @('app.exe', 'Puca.exe', 'Puca-Lite.exe')
# Leaf folder names an install of ours can have (the old one, both variants).
# Built OUTSIDE the array literal: inside @( ) the comma binds tighter than +,
# so 'P' + [char]0x00FA + 'ca' would have become three separate elements.
$pucaName = 'P' + [char]0x00FA + 'ca'
$ourLeaves = @('Sovereign', $pucaName, 'Puca', ($pucaName + ' Lite'), 'Puca Lite')
$folders = if ($Roots) { $Roots } else { @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\StartMenu'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch')
) }
$shell = New-Object -ComObject WScript.Shell
$repaired = 0; $removed = 0
foreach ($folder in $folders) {
    if (-not $folder -or -not (Test-Path -LiteralPath $folder)) { continue }
    $links = Get-ChildItem -LiteralPath $folder -Filter *.lnk -Recurse -ErrorAction SilentlyContinue
    foreach ($lnk in $links) {
        try {
            $sc = $shell.CreateShortcut($lnk.FullName)
            $target = [string]$sc.TargetPath
            if (-not $target) { continue }
            $leaf = [IO.Path]::GetFileName($target)
            if ($oldBinaries -notcontains $leaf) { continue }
            if (Test-Path -LiteralPath $target) { continue }              # still valid: not ours to touch
            $dirLeaf = [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($target))
            if ($env:PUCA_REPAIR_DEBUG) { Write-Output ("debug: {0} leaf={1} dirLeaf=[{2}] ours={3}" -f $lnk.Name, $leaf, (([int[]][char[]]$dirLeaf) -join ','), ($ourLeaves -contains $dirLeaf)) }
            if ($ourLeaves -notcontains $dirLeaf) { continue }             # somebody else's app.exe
            if ($lnk.Name -ieq 'Sovereign.lnk') {
                $sibling = Get-ChildItem -LiteralPath $lnk.DirectoryName -Filter *.lnk -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -ne $lnk.Name -and $_.Name -match '^P.ca' }
                if ($sibling) { Remove-Item -LiteralPath $lnk.FullName -Force; $removed++; Write-Output "repair-shortcuts: removed stale $($lnk.FullName)"; continue }
            }
            $sc.TargetPath = $newTarget
            $sc.WorkingDirectory = $InstallDir
            $sc.IconLocation = "$newTarget,0"
            $sc.Save()
            $repaired++
            Write-Output "repair-shortcuts: $($lnk.FullName) -> $newTarget"
        } catch {
            Write-Output "repair-shortcuts: skipped $($lnk.FullName): $($_.Exception.Message)"
        }
    }
}
Write-Output "repair-shortcuts: $repaired retargeted, $removed removed"
exit 0
