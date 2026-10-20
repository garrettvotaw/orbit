<#
.SYNOPSIS
  Creates Windows shortcuts that launch Orbit without a terminal.

.DESCRIPTION
  Points the shortcuts straight at Electron's exe with the repo as the app path, so
  double-clicking opens the already-built app with no console window. Run `npm run build`
  after code changes; the shortcut does not rebuild.

  Always creates:  Desktop\Orbit.lnk and Start Menu\Programs\Orbit.lnk
  With -Startup:   Startup\Orbit.lnk that launches hidden into the tray at sign-in
  With -Remove:    deletes all three

.EXAMPLE
  npm run shortcut
  npm run shortcut -- -Startup
  npm run shortcut -- -Remove
#>
[CmdletBinding()]
param(
  [switch]$Startup,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$icon = Join-Path $root 'assets\orbit.ico'
$dist = Join-Path $root 'dist\main\main.js'

$shell = New-Object -ComObject WScript.Shell
$targets = @{
  Desktop   = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Orbit.lnk'
  StartMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Orbit.lnk'
  Startup   = Join-Path ([Environment]::GetFolderPath('Startup')) 'Orbit.lnk'
}

if ($Remove) {
  foreach ($kv in $targets.GetEnumerator()) {
    if (Test-Path $kv.Value) { Remove-Item $kv.Value; Write-Host "removed $($kv.Key): $($kv.Value)" }
  }
  return
}

if (-not (Test-Path $electron)) { throw "Electron not installed at $electron. Run npm install first." }
if (-not (Test-Path $icon)) { throw "Icon missing at $icon. Run npm run icons first." }
if (-not (Test-Path $dist)) { Write-Warning "No build at $dist yet. Run npm run build before using the shortcut." }

function New-OrbitShortcut([string]$path, [string]$arguments, [string]$description) {
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $electron
  $lnk.Arguments = $arguments
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = $description
  $lnk.WindowStyle = 7
  $lnk.Save()
  Write-Host "wrote $path"
}

$appArg = '"' + $root + '"'
New-OrbitShortcut $targets.Desktop $appArg 'Orbit - Claude PM sessions'
New-OrbitShortcut $targets.StartMenu $appArg 'Orbit - Claude PM sessions'

if ($Startup) {
  New-OrbitShortcut $targets.Startup ($appArg + ' --hidden') 'Orbit - starts in the tray at sign-in'
} elseif (Test-Path $targets.Startup) {
  Write-Host "Startup shortcut already present: $($targets.Startup) (pass -Remove to clear all)"
}
