import type { Settings } from './settings.ts'

type Data = Record<string, unknown>
const plain = (value: unknown): value is Data => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
const shortString = (value: unknown, max = 2000) => typeof value === 'string' && value.length <= max
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const STEPS = ['stats', 'claim', 'dailySet', 'keepEarning', 'search', 'imageSearch']
const enums: Record<string, readonly string[]> = {
  tabCloseMode: ['perStep', 'routine'], appearance: ['light', 'dark', 'auto'],
  theme: ['catppuccin', 'geist', 'primer', 'nord', 'dracula', 'tokyo', 'gruvbox', 'rose'],
  background: ['aurora', 'bokeh', 'fireflies', 'swirl', 'glow', 'beams', 'rays', 'spotlight', 'meteors', 'snow', 'rain', 'bubbles', 'waves', 'stars', 'dots', 'grid', 'hex', 'checker', 'stripes', 'mesh', 'ripple', 'orbit', 'retro', 'noise', 'cursor', 'particles', 'parallax', 'constellation', 'none'],
}
const ranges: Record<string, [number, number]> = {
  searchesPerBatch: [1, 1000], minDelaySec: [0, 3600], maxDelaySec: [0, 3600],
  prowlMinIntervalMin: [1, 1440], prowlMaxIntervalMin: [1, 1440], tabCloseDelaySec: [0, 60],
  dailySetMaxTiles: [1, 10], keepEarningMaxTiles: [0, 20], redeemGoalPts: [0, 10000000],
  backgroundBrightness: [0, 200], tileBlur: [0, 30], popupHeight: [0, 600], restockIntervalMin: [15, 1440],
}

// Live reads tolerate invalid fields individually; imports and writes use strict validation.
export function validateSettings(value: unknown, defaults: Settings, strict = true): Partial<Settings> {
  if (!plain(value)) { if (strict) throw new Error('No valid settings object.'); return {} }
  const clean: Data = {}
  for (const [key, setting] of Object.entries(value)) {
    if (!Object.hasOwn(defaults, key)) continue
    const fallback = defaults[key as keyof Settings]
    let valid = false
    if (typeof fallback === 'boolean') valid = typeof setting === 'boolean'
    else if (typeof fallback === 'number') {
      const [min, max] = ranges[key] || [0, 10000000]
      valid = finite(setting) && (setting as number) >= min && (setting as number) <= max
      if (key === 'popupHeight') valid = valid && (setting === 0 || (setting as number) >= 240)
    } else if (Array.isArray(fallback)) {
      valid = Array.isArray(setting) && setting.length <= 50 && setting.every((part) => shortString(part, 100)) && new Set(setting).size === setting.length
      const allowed = key === 'startupOrder' ? STEPS : key === 'querySourceOrder' ? ['bingAutosuggest', 'googleTrends', 'wikipedia', 'uselessFacts', 'local'] : ['today', 'runNow', 'redeem', 'activity']
      valid = valid && (setting as unknown[]).every((part) => allowed.includes(String(part)))
    } else if (typeof fallback === 'string') {
      valid = shortString(setting, 100)
      if (enums[key]) valid = enums[key].includes(setting as string)
      else if (/Time$|HoursStart$|HoursEnd$/.test(key)) valid = typeof setting === 'string' && TIME.test(setting)
      else if (key === 'accentColor') valid = setting === '' || (typeof setting === 'string' && /^#?[\da-f]{6}$/i.test(setting))
    }
    if (!valid) { if (strict) throw new Error(`Invalid setting: ${key}.`); continue }
    clean[key] = structuredClone(setting)
  }
  if (finite(clean.minDelaySec) && finite(clean.maxDelaySec) && Number(clean.maxDelaySec) < Number(clean.minDelaySec)) { if (strict) throw new Error('The maximum search delay is smaller than the minimum.'); delete clean.maxDelaySec }
  return clean as Partial<Settings>
}

export function normalizeSettings(stored: unknown, defaults: Settings): Settings {
  const settings = { ...structuredClone(defaults), ...validateSettings(stored, defaults, false) }
  settings.maxDelaySec = Math.max(settings.minDelaySec, settings.maxDelaySec)
  settings.prowlMaxIntervalMin = Math.max(settings.prowlMinIntervalMin, settings.prowlMaxIntervalMin)
  return settings
}
