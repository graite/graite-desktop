# Pack the Windows release build into an unsigned .msix for the Microsoft Store.
# Run after `tauri build` on Windows (release.yml does). The Store signs the package itself.
#
#   pwsh scripts/build-msix.ps1 [-Layout <dir>]
#
# Identity comes from Partner Center > Product management > Product identity, via env vars:
#   MSIX_IDENTITY_NAME, MSIX_PUBLISHER, MSIX_PUBLISHER_DISPLAY_NAME
# Without them the package gets a placeholder identity (fine for a dry run, refused by the Store).
param(
  # Short on purpose: the PyInstaller onedir is deep and Windows tools trip over 260 characters.
  [string]$Layout = (Join-Path ($env:RUNNER_TEMP ?? [IO.Path]::GetTempPath()) 'msix')
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$tauri = Join-Path $root 'apps/desktop/src-tauri'
$release = Join-Path $tauri 'target/release'
$outDir = Join-Path $release 'bundle/msix'

# ---- Version: tauri.conf.json x.y.z -> x.y.z.0 (the Store requires the 4th part to be 0) ----
$conf = Get-Content (Join-Path $tauri 'tauri.conf.json') -Raw | ConvertFrom-Json
if ($conf.version -notmatch '^\d+\.\d+\.\d+$') { throw "tauri.conf.json version '$($conf.version)' is not x.y.z" }
$version = "$($conf.version).0"

# ---- Identity ----
function Get-Setting([string]$name, [string]$placeholder) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    Write-Host "::warning::$name is not set; using a placeholder. The Store will refuse this package."
    return $placeholder
  }
  return $value.Trim()
}
$name = Get-Setting 'MSIX_IDENTITY_NAME' 'Graite.Dev'
$publisher = Get-Setting 'MSIX_PUBLISHER' 'CN=Graite Dev'
$publisherName = Get-Setting 'MSIX_PUBLISHER_DISPLAY_NAME' 'Graite Dev'
$esc = { param($s) [Security.SecurityElement]::Escape($s) }

# ---- Layout: the app exe with its resources beside it, as Tauri resolves them ----
$exe = Join-Path $release 'graite-desktop.exe'
$daemon = Join-Path $tauri 'resources/daemon'
if (-not (Test-Path $exe)) { throw "no release build at $exe (run tauri build first)" }
if (-not (Test-Path (Join-Path $daemon 'graite-daemon.exe'))) { throw "no sidecar in $daemon (run scripts/place-sidecar.sh)" }

if (Test-Path $Layout) { Remove-Item $Layout -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $Layout 'resources'), (Join-Path $Layout 'Assets') | Out-Null
Copy-Item $exe $Layout
Copy-Item $daemon (Join-Path $Layout 'resources/daemon') -Recurse
Remove-Item (Join-Path $Layout 'resources/daemon/.gitkeep') -ErrorAction SilentlyContinue
foreach ($logo in 'Square44x44Logo.png', 'Square150x150Logo.png', 'StoreLogo.png') {
  Copy-Item (Join-Path $tauri "icons/$logo") (Join-Path $Layout 'Assets')
}

$manifest = (Get-Content (Join-Path $root 'packaging/msix/AppxManifest.xml.in') -Raw).
  Replace('@NAME@', (& $esc $name)).
  Replace('@PUBLISHER@', (& $esc $publisher)).
  Replace('@PUBLISHER_DISPLAY_NAME@', (& $esc $publisherName)).
  Replace('@VERSION@', $version)
if ($manifest -match '@[A-Z_]+@') { throw "unfilled placeholder in the manifest: $($Matches[0])" }
Set-Content -Path (Join-Path $Layout 'AppxManifest.xml') -Value $manifest -Encoding utf8NoBOM

# ---- Pack ----
$makeappx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" -ErrorAction SilentlyContinue |
  Sort-Object { [version]$_.Directory.Parent.Name } -Descending | Select-Object -First 1
if (-not $makeappx) { throw 'makeappx.exe not found (install the Windows 10/11 SDK)' }

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$msix = Join-Path $outDir "Graite_${version}_x64.msix"
& $makeappx.FullName pack /d $Layout /p $msix /o
if ($LASTEXITCODE -ne 0) { throw "makeappx pack failed ($LASTEXITCODE)" }

# ---- Sanity check: the daemon made it into the package ----
$check = Join-Path ($env:RUNNER_TEMP ?? [IO.Path]::GetTempPath()) 'msix-check'
if (Test-Path $check) { Remove-Item $check -Recurse -Force }
& $makeappx.FullName unpack /p $msix /d $check /o | Out-Null
if ($LASTEXITCODE -ne 0) { throw "makeappx unpack failed ($LASTEXITCODE)" }
if (-not (Test-Path (Join-Path $check 'resources/daemon/graite-daemon.exe'))) { throw 'the daemon is missing from the package' }
Remove-Item $check -Recurse -Force

Write-Output "msix: $msix ($([math]::Round((Get-Item $msix).Length / 1MB)) MB, identity $name, version $version)"
Write-Output "layout: $Layout"
