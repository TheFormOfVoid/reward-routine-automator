import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const updater = fileURLToPath(new URL('../updater/Update Gingerbread.ps1', import.meta.url))
const name = 'Reward Routine Automator — Gingerbread'
const manifest = (version: string, build = name, worker = 'worker.js') => JSON.stringify({
  manifest_version: 3, name: build, version,
  background: { service_worker: worker }, action: { default_popup: 'index.html' },
})

// Run the real updater against disposable folders. Both network cmdlets and
// extraction are replaced: no requests or installation targets are reachable.
function exercise(options: { version?: string; build?: string; targetBuild?: string; failAsset?: boolean; corruptAsset?: boolean; missingWorker?: boolean; missingImport?: boolean; remoteWorker?: boolean; wrongDigest?: boolean; unsafeArchive?: boolean; failCleanup?: boolean; failRollback?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gingerbread-updater-test-'))
  const target = join(root, 'installed')
  const release = join(root, 'release')
  mkdirSync(join(target, 'updater'), { recursive: true })
  mkdirSync(join(release, 'assets'), { recursive: true })
  mkdirSync(join(release, 'updater'), { recursive: true })
  writeFileSync(join(target, 'manifest.json'), manifest('6.9.8', options.targetBuild))
  writeFileSync(join(target, 'old.js'), 'old asset')
  writeFileSync(join(target, 'worker.js'), 'old worker')
  writeFileSync(join(target, 'index.html'), 'old popup')
  writeFileSync(join(target, 'updater', 'keep.cmd'), 'keep updater')
  writeFileSync(join(release, 'manifest.json'), manifest(options.version ?? '6.10.0', options.build, options.remoteWorker ? 'https://example.invalid/worker.js' : 'worker.js'))
  if (!options.missingWorker) writeFileSync(join(release, 'worker.js'), options.missingImport ? 'import "./assets/missing.js"' : 'new worker')
  writeFileSync(join(release, 'index.html'), 'new popup')
  writeFileSync(join(release, 'assets', 'new.js'), 'new asset')
  writeFileSync(join(release, 'updater', 'keep.cmd'), 'must not replace updater')
  const wrapper = join(root, 'offline.ps1')
  writeFileSync(wrapper, `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($env:GB_RELEASE, $env:GB_DOWNLOAD)
if ($env:GB_UNSAFE_ARCHIVE -eq 'yes') {
  $zip = [IO.Compression.ZipFile]::Open($env:GB_DOWNLOAD, [IO.Compression.ZipArchiveMode]::Update)
  try { $zip.CreateEntry('../escape.js') | Out-Null } finally { $zip.Dispose() }
}
$env:GB_ASSET_DIGEST = 'sha256:' + (Get-FileHash -LiteralPath $env:GB_DOWNLOAD).Hash.ToLowerInvariant()
if ($env:GB_WRONG_DIGEST -eq 'yes') { $env:GB_ASSET_DIGEST = 'sha256:' + ('0' * 64) }
function Invoke-RestMethod {
  @(
    @{ draft = $true; assets = @(@{ name = 'Gingerbread-draft.zip'; browser_download_url = 'draft' }) },
    @{ prerelease = $true; assets = @(@{ name = 'Gingerbread-preview.zip'; browser_download_url = 'preview' }) },
    @{ tag_name = 'stable'; assets = @(@{ name = 'Gingerbread.zip'; browser_download_url = 'offline'; digest = $env:GB_ASSET_DIGEST }) }
  )
}
function Invoke-WebRequest {
  param($Uri, $OutFile, $UserAgent, [switch]$UseBasicParsing)
  if ($Uri -ne 'offline') { throw 'Updater selected an unstable release' }
  Microsoft.PowerShell.Management\\Copy-Item -LiteralPath $env:GB_DOWNLOAD -Destination $OutFile
}
function Expand-Archive {
  param($LiteralPath, $DestinationPath, [switch]$Force)
  New-Item -ItemType Directory -Path $DestinationPath | Out-Null
  Get-ChildItem -LiteralPath $env:GB_RELEASE -Force | ForEach-Object {
    Microsoft.PowerShell.Management\\Copy-Item -LiteralPath $_.FullName -Destination $DestinationPath -Recurse -Force
  }
}
function Copy-Item {
  param($LiteralPath, $Destination, [switch]$Force)
  if ($env:GB_FAIL_ASSET -eq 'yes' -and $LiteralPath.EndsWith('new.js')) { throw 'Simulated asset-copy failure' }
  if ($env:GB_CORRUPT_ASSET -eq 'yes' -and $LiteralPath.EndsWith('new.js')) { Set-Content -LiteralPath $Destination -Value 'corrupt copy'; return }
  if ($env:GB_FAIL_ROLLBACK -eq 'yes' -and $LiteralPath.Contains('previous-install')) { throw 'Simulated rollback failure' }
  if (-not $LiteralPath.Contains('previous-install') -and $LiteralPath.EndsWith('manifest.json') -and -not (Test-Path -LiteralPath (Join-Path $env:GB_TARGET 'assets/new.js'))) {
    throw 'Manifest copied before assets'
  }
  Microsoft.PowerShell.Management\\Copy-Item -LiteralPath $LiteralPath -Destination $Destination -Force
}
function Remove-Item {
  param($LiteralPath, [switch]$Force, [switch]$Recurse)
  if ($env:GB_FAIL_CLEANUP -eq 'yes' -and $LiteralPath.EndsWith('old.js') -and -not $script:cleanupFailed) {
    $script:cleanupFailed = $true
    throw 'Simulated stale-file cleanup failure'
  }
  Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $LiteralPath -Force:$Force -Recurse:$Recurse
}
& $env:GB_UPDATER -Target $env:GB_TARGET
exit $LASTEXITCODE
`, 'utf8')
  const childEnvironment = { ...process.env }
  // CI invokes Node from PowerShell7. Its module search path must not override
  // Windows PowerShell5's modules when testing the actual Windows launcher.
  for (const key of Object.keys(childEnvironment)) if (key.toLowerCase() === 'psmodulepath') delete childEnvironment[key]
  const run = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...childEnvironment, GB_RELEASE: release, GB_TARGET: target, GB_UPDATER: updater, GB_DOWNLOAD: join(root, 'payload.zip'),
      GB_FAIL_ASSET: options.failAsset ? 'yes' : 'no', GB_WRONG_DIGEST: options.wrongDigest ? 'yes' : 'no', GB_UNSAFE_ARCHIVE: options.unsafeArchive ? 'yes' : 'no',
      GB_CORRUPT_ASSET: options.corruptAsset ? 'yes' : 'no',
      GB_FAIL_CLEANUP: options.failCleanup ? 'yes' : 'no', GB_FAIL_ROLLBACK: options.failRollback ? 'yes' : 'no' },
  })
  const result = {
    status: run.status, output: run.stdout + run.stderr, error: run.error,
    installed: JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')),
    updater: readFileSync(join(target, 'updater', 'keep.cmd'), 'utf8'),
    oldAsset: existsSync(join(target, 'old.js')), newAsset: existsSync(join(target, 'assets', 'new.js')),
    backupVersion: existsSync(join(target, 'updater', 'previous-install', 'manifest.json')) ? JSON.parse(readFileSync(join(target, 'updater', 'previous-install', 'manifest.json'), 'utf8')).version : null,
    oldBytes: existsSync(join(target, 'old.js')) ? readFileSync(join(target, 'old.js'), 'utf8') : null,
    workerBytes: readFileSync(join(target, 'worker.js'), 'utf8'), popupBytes: readFileSync(join(target, 'index.html'), 'utf8'),
  }
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith('gingerbread-updater-test-')) throw new Error('Unsafe fixture cleanup path')
  rmSync(root, { recursive: true, force: true })
  assert.equal(run.error, undefined, String(run.error))
  return result
}

test('offline updater installs newer stable Gingerbread assets before the manifest and preserves itself', { skip: process.platform !== 'win32' }, () => {
  const result = exercise()
  assert.equal(result.status, 0, result.output)
  assert.equal(result.installed.version, '6.10.0')
  assert.equal(result.newAsset, true)
  assert.equal(result.oldAsset, false)
  assert.equal(result.updater, 'keep updater')
  assert.equal(result.backupVersion, '6.9.8')
  assert.equal(result.workerBytes, 'new worker')
  assert.equal(result.popupBytes, 'new popup')
})

for (const version of ['6.9.7', '6.9.8', '6.9.8.0']) {
  test(`offline updater refuses older/equal version ${version}`, { skip: process.platform !== 'win32' }, () => {
    const result = exercise({ version })
    assert.equal(result.status, 0, result.output)
    assert.equal(result.installed.version, '6.9.8')
    assert.equal(result.oldAsset, true)
    assert.equal(result.newAsset, false)
    assert.equal(result.workerBytes, 'old worker')
    assert.equal(result.popupBytes, 'old popup')
  })
}

for (const options of [
  { build: 'Reward Routine Automator — Froyo' },
  { targetBuild: 'Reward Routine Automator — Froyo' },
  { version: 'invalid' },
  { version: '99999.0.0' },
  { missingWorker: true },
  { failAsset: true },
  { corruptAsset: true },
  { missingImport: true },
  { remoteWorker: true },
  { wrongDigest: true },
  { unsafeArchive: true },
  { failCleanup: true },
]) {
  test(`offline updater preserves the manifest on validation/copy failure ${JSON.stringify(options)}`, { skip: process.platform !== 'win32' }, () => {
    const result = exercise(options)
    assert.notEqual(result.status, 0, result.output)
    assert.equal(result.installed.version, '6.9.8')
    assert.equal(result.oldAsset, true)
    assert.equal(result.updater, 'keep updater')
    assert.equal(result.oldBytes, 'old asset')
    assert.equal(result.newAsset, false)
    assert.equal(result.workerBytes, 'old worker')
    assert.equal(result.popupBytes, 'old popup')
    if (options.wrongDigest) assert.match(result.output, /checksum does not match/)
    if (options.unsafeArchive) assert.match(result.output, /archive entry escapes/)
    if (options.missingImport) assert.match(result.output, /Missing or invalid packaged asset/)
    if (options.missingWorker) assert.match(result.output, /Missing or invalid packaged asset: worker.js/)
    if (options.remoteWorker) assert.match(result.output, /not packaged locally/)
    if (options.failAsset) assert.match(result.output, /Simulated asset-copy failure/)
    if (options.corruptAsset) assert.match(result.output, /Copied asset verification failed/)
    if (options.failCleanup) assert.match(result.output, /Simulated stale-file cleanup failure/)
  })
}

test('updater retains recovery files and reports the location if rollback also fails', { skip: process.platform !== 'win32' }, () => {
  const result = exercise({ failCleanup: true, failRollback: true })
  assert.notEqual(result.status, 0)
  assert.equal(result.backupVersion, '6.9.8')
  assert.match(result.output, /rollback also failed/)
  assert.match(result.output, /previous-install/)
})
