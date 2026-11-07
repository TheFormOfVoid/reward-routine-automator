// Configuration from environment variables (docker compose / .env), or from
// /data/options.json when running as a Home Assistant add-on. Options win
// over the environment so the add-on's Configuration tab is the one place to
// change things there.

import fs from 'node:fs'
import path from 'node:path'

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/

function int(value, fallback, min, max, name) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max} (got "${value}")`)
  return n
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return /^(1|true|yes|on)$/i.test(String(value).trim())
}

export function loadConfig(env = process.env) {
  const dataDir = env.DATA_DIR || '/data'
  let opts = {}
  const optionsFile = path.join(dataDir, 'options.json')
  const haAddon = fs.existsSync(optionsFile)
  if (haAddon) opts = JSON.parse(fs.readFileSync(optionsFile, 'utf8'))
  const pick = (optKey, envKey) => (opts[optKey] !== undefined && opts[optKey] !== '' ? opts[optKey] : env[envKey])

  const runTime = String(pick('run_time', 'RUN_TIME') || '09:30').trim()
  if (!TIME.test(runTime)) throw new Error(`RUN_TIME must be 24-hour HH:MM (got "${runTime}")`)
  const tz = pick('timezone', 'TZ')
  if (tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }) } catch { throw new Error(`Unknown timezone "${tz}"`) }
    process.env.TZ = tz
  }

  return {
    haAddon,
    dataDir,
    profileDir: path.join(dataDir, 'profile'),
    logDir: path.join(dataDir, 'logs'),
    stateFile: path.join(dataDir, 'state.json'),
    timezone: tz || Intl.DateTimeFormat().resolvedOptions().timeZone,
    runTime,
    jitterMin: int(pick('jitter_minutes', 'RUN_JITTER_MIN'), 0, 0, 180, 'RUN_JITTER_MIN'),
    timeoutMin: int(pick('timeout_minutes', 'RUN_TIMEOUT_MIN'), 90, 10, 360, 'RUN_TIMEOUT_MIN'),
    maxAttempts: int(pick('max_attempts', 'MAX_ATTEMPTS'), 3, 1, 10, 'MAX_ATTEMPTS'),
    retryDelayMin: int(pick('retry_delay_minutes', 'RETRY_DELAY_MIN'), 15, 1, 240, 'RETRY_DELAY_MIN'),
    incompleteRetryMin: int(pick('incomplete_retry_minutes', 'INCOMPLETE_RETRY_MIN'), 120, 0, 720, 'INCOMPLETE_RETRY_MIN'),
    catchUp:bool(pick('catch_up', 'CATCH_UP'), true),
    notifyUrl: String(pick('notify_url', 'NOTIFY_URL') || '').trim(),
    notifyOnSuccess: bool(pick('notify_on_success', 'NOTIFY_ON_SUCCESS'), false),
    // Home Assistant add-on only: push to the Companion app on your phone.
    notifyPhone: bool(opts.notify_phone, true),
    notifyService: String(opts.notify_service || '').trim(),
    loginIdleCloseMin: int(env.LOGIN_IDLE_CLOSE_MIN, 30, 5, 600, 'LOGIN_IDLE_CLOSE_MIN'),
    webPort: int(env.WEB_PORT, 8099, 1, 65535, 'WEB_PORT'),
    webPassword: haAddon ? '' : String(env.WEB_PASSWORD || ''),
    chromiumPath: env.CHROMIUM_PATH || '/usr/bin/chromium',
    extensionDir: env.EXTENSION_DIR || '/opt/extension',
    debugPort: int(env.CDP_PORT, 9222, 1, 65535, 'CDP_PORT'),
    display: env.DISPLAY || ':99',
    screenWidth: 1366,
    screenHeight: 768,
    // Set DISPLAY_STACK=0 to skip Xvfb/x11vnc/websockify (local testing).
    displayStack: bool(env.DISPLAY_STACK, true),
    novncDir: env.NOVNC_DIR || '/usr/share/novnc',
    extraChromiumArgs: [
      // The container runs as root and has no user namespaces to sandbox in.
      ...(bool(env.CHROMIUM_NO_SANDBOX, true) ? ['--no-sandbox'] : []),
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--metrics-recording-only',
      ...String(env.CHROMIUM_ARGS || '').split(/\s+/).filter(Boolean),
    ],
  }
}
