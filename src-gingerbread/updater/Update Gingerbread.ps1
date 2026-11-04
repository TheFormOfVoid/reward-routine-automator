<#
  Reward Routine Automator — Gingerbread: the one-click updater.

  Why this exists: Gingerbread ships as a zip on a GitHub Release, and updating
  it by hand means finding the newest release, downloading the asset, working
  out which folder Chrome is actually loading, copying over it, and clicking
  Reload in chrome://extensions. This collapses that into one double-click.

  Why it sits INSIDE the extension folder: it targets its own parent directory
  by default. The folder Chrome loads unpacked IS the folder this was unzipped
  into, so there is nothing to configure and no first-run folder picker — that
  zero setup is what makes it one click instead of three.

  Why a reload click still remains: this script writes files to disk, but
  Chrome holds the extension in memory and never re-reads that folder on its
  own. No API lets an extension — or a script outside it — press Reload. So the
  popup gains a Restart control that appears only when it notices the folder's
  manifest.json version no longer matches the version Chrome has loaded.

  Unpacked extensions cannot auto-update at all: Chrome's self-hosted
  update_url/updates.xml path is [BLOCKED] on Windows for any machine that is
  not enterprise-managed. See docs/architecture/adr-024-one-click-updater.md.

  Unauthenticated against the GitHub API — 60 requests/hour is ample for this.
#>
[CmdletBinding()]
param(
  # The extension folder to update. Defaults to this script's parent, which is
  # the extension root in the shipped zip's layout (updater/ beside manifest.json).
  [string]$Target = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 negotiates TLS 1.0 on older builds and GitHub refuses
# it, and the GitHub API requires a User-Agent. Both failures are silent enough
# to be worth pinning here rather than debugging later.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$UserAgent = 'RewardRoutineAutomator-Gingerbread-Updater'

$Repo = 'entropy63/reward-routine-automator'
$AssetPattern = '*Gingerbread*.zip'

# The one folder the sync never writes to and never deletes from. The running
# .cmd is held open by cmd.exe while it executes, so copying over it fails; the
# whole folder is excluded instead of just that file, which keeps the rule
# simple to state. The updater therefore does not update itself — if it ever
# changes, the release notes say so and this one file is re-downloaded by hand.
$KeepDir = 'updater'

function Write-Step($text) { Write-Host "  $text" }

# Read and identify the build, not just a version-shaped field: a mislabeled
# release asset must never install another variant over Gingerbread.
function Get-ManifestVersion([string]$Dir) {
  $path = Join-Path $Dir 'manifest.json'
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try {
    $manifest = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    $expectedName = 'Reward Routine Automator ' + [char]0x2014 + ' Gingerbread'
    if ($manifest.manifest_version -ne 3 -or $manifest.name -cne $expectedName) { return $null }
    if ($manifest.version -isnot [string] -or $manifest.version -notmatch '^\d+(\.\d+){0,3}$') { return $null }
    $parts = @($manifest.version.Split('.'))
    if (@($parts | Where-Object { $_.Length -gt 5 -or [int]$_ -gt 65535 }).Count) { return $null }
    while ($parts.Count -lt 4) { $parts += '0' }
    if ([version]($parts -join '.') -eq [version]'0.0.0.0') { return $null }
    return $manifest.version
  } catch {
    return $null
  }
}

function Get-ComparableVersion([string]$Version) {
  $parts = @($Version.Split('.'))
  while ($parts.Count -lt 4) { $parts += '0' }
  return [version]($parts -join '.')
}

# A junction/symlink inside either tree could redirect a copy or removal outside
# the chosen extension folder. Refuse it before the sync touches any files.
function Assert-RegularTree([string]$Root) {
  $entries = @((Get-Item -LiteralPath $Root -Force)) + @(Get-ChildItem -LiteralPath $Root -Recurse -Force)
  if (@($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) {
    throw "Linked folders or files are not supported: $Root"
  }
}

# Every file under $Root as a set of relative paths — the two halves of the
# sync diff (what to copy, what to delete) are both "is this path in here".
function Get-RelativeFileSet([string]$Root) {
  $set = @{}
  Get-ChildItem -LiteralPath $Root -Recurse -File -Force | ForEach-Object {
    $set[$_.FullName.Substring($Root.Length).TrimStart('\')] = $true
  }
  return $set
}

function Test-Kept([string]$Relative) {
  return $Relative -eq $KeepDir -or $Relative.StartsWith("$KeepDir\", [StringComparison]::OrdinalIgnoreCase)
}

function Assert-ArchiveEntries([string]$Zip, [string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $root = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
  $archive = [IO.Compression.ZipFile]::OpenRead($Zip)
  try {
    if ($archive.Entries.Count -gt 5000) { throw 'The release contains too many files.' }
    $total = 0L
    foreach ($entry in $archive.Entries) {
      $path = [IO.Path]::GetFullPath((Join-Path $Destination $entry.FullName))
      if (-not $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'An archive entry escapes the extension folder.' }
      if (($entry.ExternalAttributes -shr 16 -band 61440) -eq 40960) { throw 'Linked archive entries are not supported.' }
      $total += $entry.Length
      if ($total -gt 100MB) { throw 'The extracted release exceeds the size limit.' }
    }
  } finally { $archive.Dispose() }
}

function Assert-AssetReference([string]$Root, [string]$Owner, [string]$Reference, [bool]$RequiredLocal = $false) {
  if (-not $Reference -or $Reference.StartsWith('#')) { return }
  if ($Reference -match '^[a-z][a-z0-9+.-]*:' -or $Reference.StartsWith('//')) {
    if ($RequiredLocal) { throw "An extension entry point or import is not packaged locally: $Reference" }
    return
  }
  $relative = ([Uri]::UnescapeDataString($Reference) -split '[?#]', 2)[0]
  if (-not $relative) { return }
  $base = Split-Path -Parent $Owner
  if ($relative.StartsWith('/') -or $relative.StartsWith('assets/')) {
    $base = $Root
    $relative = $relative.TrimStart('/')
  }
  $full = [IO.Path]::GetFullPath((Join-Path $base $relative))
  if (-not $full.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
    throw "Missing or invalid packaged asset: $Reference"
  }
}

# Check the complete packaged graph, including lazy UI chunks and CSS. A
# valid worker-loader file alone does not prove its imported worker exists.
function Assert-PackageAssets([string]$Root) {
  $manifestPath = Join-Path $Root 'manifest.json'
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $references = @($manifest.background.service_worker, $manifest.action.default_popup)
  if (-not $references[0] -or -not $references[1]) { throw 'The release is missing its worker or popup entry point.' }
  if ($manifest.icons) { $references += @($manifest.icons.PSObject.Properties | ForEach-Object { $_.Value }) }
  if ($manifest.action.default_icon) { $references += @($manifest.action.default_icon.PSObject.Properties | ForEach-Object { $_.Value }) }
  foreach ($content in @($manifest.content_scripts)) { if ($content) { $references += @($content.js) + @($content.css) } }
  foreach ($reference in $references) { if ($reference) { Assert-AssetReference $Root $manifestPath $reference $true } }
  Get-ChildItem -LiteralPath $Root -Recurse -File | Where-Object { $_.Extension -in '.html', '.js', '.css' } | ForEach-Object {
    $text = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8
    $patterns = switch ($_.Extension) {
      '.html' { '(?:src|href)\s*=\s*["'']([^"'']+)["'']' }
      '.js' { '(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\bimportScripts\s*\(\s*)["'']([^"'']+)["'']'; '["'']((?:/?assets/)[^"'']+\.(?:js|css|png|svg|woff2?))["'']' }
      '.css' { 'url\(\s*["'']?([^"'')]+)'; '@import\s*["'']([^"'']+)["'']' }
    }
    foreach ($pattern in $patterns) {
      foreach ($match in [regex]::Matches($text, $pattern)) { Assert-AssetReference $Root $_.FullName $match.Groups[1].Value.Trim() ($_.Extension -eq '.js') }
    }
  }
}

Write-Host ''
Write-Host 'Reward Routine Automator — Gingerbread updater' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path -LiteralPath $Target -PathType Container)) {
  Write-Host "Not a folder: $Target" -ForegroundColor Red
  exit 1
}
$Target = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Target).Path).TrimEnd('\')

$current = Get-ManifestVersion $Target
if (-not $current) {
  Write-Host "No valid Gingerbread Manifest V3 extension in $Target." -ForegroundColor Red
  Write-Host 'Point this at the folder you load unpacked.' -ForegroundColor Red
  exit 1
}
Write-Step "Installed: $current"

# --- Find the newest Gingerbread release -----------------------------------
# /releases/latest is the newest release of ANY build, so a future Cupcake or
# Froyo release would break it. Walking the list and taking the first release
# that actually carries a Gingerbread zip is the version that keeps working.
Write-Step 'Checking GitHub for the newest release...'
try {
  # @() so a single-release answer is still a list to walk, not a bare object.
  $releases = @(Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=20" -UserAgent $UserAgent -Headers @{ Accept = 'application/vnd.github+json' })
} catch {
  Write-Host "Could not reach GitHub: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

$asset = $null
$release = $null
foreach ($r in $releases) {
  if ($r.draft -or $r.prerelease) { continue }
  $match = $r.assets | Where-Object { $_.name -like $AssetPattern } | Select-Object -First 1
  if ($match) { $release = $r; $asset = $match; break }
}
if (-not $asset) {
  Write-Host "No Gingerbread zip found in the last $($releases.Count) releases." -ForegroundColor Red
  exit 1
}
Write-Step "Newest:    $($release.tag_name)  ($($asset.name))"

# --- Download and stage ----------------------------------------------------
$work = [IO.Path]::GetFullPath((Join-Path $env:TEMP ('gb-update-' + [Guid]::NewGuid().ToString('N'))))
$zipPath = Join-Path $work 'release.zip'
$stageDir = Join-Path $work 'stage'
New-Item -ItemType Directory -Path $work -Force | Out-Null

try {
  Write-Step 'Downloading...'
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -UserAgent $UserAgent -UseBasicParsing

  if ($asset.digest) {
    if ($asset.digest -notmatch '^sha256:([a-fA-F0-9]{64})$') { throw 'The release has an unsupported asset digest.' }
    if ((Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash -cne $Matches[1].ToUpperInvariant()) { throw 'The release checksum does not match the download.' }
  }

  Write-Step 'Extracting...'
  Assert-ArchiveEntries $zipPath $stageDir
  Expand-Archive -LiteralPath $zipPath -DestinationPath $stageDir -Force

  # Check the staged folder is actually an extension BEFORE anything in the
  # target is touched — a truncated download or a wrongly-shaped asset must not
  # get as far as modifying a working install.
  $staged = Get-ManifestVersion $stageDir
  if (-not $staged) {
    Write-Host 'The downloaded zip has no valid Gingerbread manifest at its root — refusing to touch your install.' -ForegroundColor Red
    exit 1
  }
  Write-Step "Available: $staged"

  if ((Get-ComparableVersion $staged) -le (Get-ComparableVersion $current)) {
    Write-Host ''
    Write-Host "Already up to date ($current); available $staged is not newer." -ForegroundColor Green
    exit 0
  }

  Assert-RegularTree $stageDir
  Assert-RegularTree $Target
  Assert-PackageAssets $stageDir

  # One retained recovery copy, under the updater folder that normal sync
  # preserves. Complete it before touching any installed runtime file.
  $backupDir = [IO.Path]::GetFullPath((Join-Path $Target 'updater/previous-install'))
  $expectedBackup = [IO.Path]::GetFullPath((Join-Path $Target $KeepDir)).TrimEnd('\') + '\previous-install'
  if ($backupDir -cne $expectedBackup) { throw 'Invalid backup path.' }
  if (Test-Path -LiteralPath $backupDir) { Assert-RegularTree $backupDir; Remove-Item -LiteralPath $backupDir -Recurse -Force }
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  Get-ChildItem -LiteralPath $Target -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($Target.Length).TrimStart('\')
    if (Test-Kept $rel) { return }
    $dest = Join-Path $backupDir $rel
    New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
    Microsoft.PowerShell.Management\Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
    if ((Get-FileHash -LiteralPath $_.FullName).Hash -ne (Get-FileHash -LiteralPath $dest).Hash) { throw 'The recovery backup could not be verified.' }
  }
  $backupFiles = Get-RelativeFileSet $backupDir

  # --- Sync ----------------------------------------------------------------
  # Copy first, delete second. That order is deliberate: once the copy lands the
  # extension is complete and working, so a failure in the delete pass leaves
  # stray files rather than a broken install.
  Write-Step "Updating $current -> $staged ..."
  try {
  Get-ChildItem -LiteralPath $stageDir -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($stageDir.Length).TrimStart('\')
    if ((Test-Kept $rel) -or $rel -eq 'manifest.json') { return }
    $dest = Join-Path $Target $rel
    $destDir = Split-Path -Parent $dest
    if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
    Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
    if ((Get-FileHash -LiteralPath $_.FullName).Hash -ne (Get-FileHash -LiteralPath $dest).Hash) { throw "Copied asset verification failed: $rel" }
  }

  # The manifest is the Restart signal. Commit it only once every asset has
  # copied successfully, so a failed copy cannot advertise a ready update.
  Copy-Item -LiteralPath (Join-Path $stageDir 'manifest.json') -Destination (Join-Path $Target 'manifest.json') -Force
  if ((Get-FileHash -LiteralPath (Join-Path $stageDir 'manifest.json')).Hash -ne (Get-FileHash -LiteralPath (Join-Path $Target 'manifest.json')).Hash) { throw 'Manifest copy verification failed.' }

  # Vite emits content-hashed bundles, so without this pass every update would
  # leave the previous version's assets/*-<oldhash>.js behind forever.
  $stagedFiles = Get-RelativeFileSet $stageDir
  $removed = 0
  Get-ChildItem -LiteralPath $Target -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($Target.Length).TrimStart('\')
    if (Test-Kept $rel) { return }
    if (-not $stagedFiles.ContainsKey($rel)) {
      Remove-Item -LiteralPath $_.FullName -Force
      $removed++
    }
  }

  # Directories the delete pass just emptied. Deepest-first so a nested empty
  # folder does not block its parent from being seen as empty too.
  Get-ChildItem -LiteralPath $Target -Recurse -Directory -Force |
    Sort-Object { $_.FullName.Length } -Descending |
    ForEach-Object {
      $rel = $_.FullName.Substring($Target.Length).TrimStart('\')
      if (Test-Kept $rel) { return }
      if (-not (Get-ChildItem -LiteralPath $_.FullName -Force)) { Remove-Item -LiteralPath $_.FullName -Force }
    }

  } catch {
    $updateError = $_.Exception.Message
    try {
      # Restore old assets before their manifest and remove files introduced
      # by the failed update. The retained backup survives either outcome.
      Get-ChildItem -LiteralPath $backupDir -Recurse -File -Force | ForEach-Object {
        $rel = $_.FullName.Substring($backupDir.Length).TrimStart('\')
        if ($rel -eq 'manifest.json') { return }
        $dest = Join-Path $Target $rel
        New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
      }
      Copy-Item -LiteralPath (Join-Path $backupDir 'manifest.json') -Destination (Join-Path $Target 'manifest.json') -Force
      Get-ChildItem -LiteralPath $Target -Recurse -File -Force | ForEach-Object {
        $rel = $_.FullName.Substring($Target.Length).TrimStart('\')
        if (-not (Test-Kept $rel) -and -not $backupFiles.ContainsKey($rel)) { Remove-Item -LiteralPath $_.FullName -Force }
      }
      foreach ($rel in $backupFiles.Keys) {
        if ((Get-FileHash -LiteralPath (Join-Path $backupDir $rel)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $Target $rel)).Hash) { throw "Rollback verification failed: $rel" }
      }
    } catch { throw "Update failed ($updateError). Automatic rollback also failed. Your recovery files are preserved in $backupDir. $($_.Exception.Message)" }
    throw "Update failed; version $current was restored. $updateError"
  }

  Write-Host ''
  Write-Host "Updated $current -> $staged" -ForegroundColor Green
  if ($removed -gt 0) { Write-Step "$removed file(s) from the old version removed." }
  Write-Step "Previous version backup: $backupDir"
  Write-Host ''
  Write-Host 'The files are in place, but Chrome is still running the old version.' -ForegroundColor Cyan
  Write-Host 'Open the extension and click Restart — the button appears by itself' -ForegroundColor Cyan
  Write-Host 'once an update is waiting. Or click Reload on the card at' -ForegroundColor Cyan
  Write-Host 'chrome://extensions.' -ForegroundColor Cyan
  Write-Host ''
} finally {
  try {
    $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    $cleanupPath = [IO.Path]::GetFullPath($work)
    if (-not $cleanupPath.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Staging cleanup escaped the temporary folder.'
    }
    Assert-RegularTree $cleanupPath
    Remove-Item -LiteralPath $cleanupPath -Recurse -Force
  } catch {
    Write-Warning "Could not clean up staging folder $work : $($_.Exception.Message)"
  }
}
