# Build a release-ready zip of the extension (no source, no node_modules).
# Output: release/plain-view.zip
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$releaseDir = Join-Path $root 'release'
$staging    = Join-Path $releaseDir 'plain-view'
$zip        = Join-Path $releaseDir 'plain-view.zip'

if (Test-Path $releaseDir) { Remove-Item $releaseDir -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null

# Whitelist: only files the browser actually needs at runtime.
# Do NOT bundle docs (README/CLAUDE/PRD), git metadata (.gitignore),
# tooling configs (tsconfig, package.json), source, or node_modules.
Copy-Item 'manifest.json','popup.html','popup.css','viewer.html','playground.html' $staging
Copy-Item 'dist','styles','icons' $staging -Recurse

Compress-Archive -Path $staging -DestinationPath $zip -Force
Remove-Item $staging -Recurse -Force

$info = Get-Item $zip
Write-Host ("OK -> {0}  ({1:N0} bytes)" -f $info.FullName, $info.Length)
