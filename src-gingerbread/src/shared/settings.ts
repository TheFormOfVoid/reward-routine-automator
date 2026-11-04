// Settings live in storage.sync (small, user-owned, worth syncing across
// devices) under one "settings" key. This module is SHARED: the worker reads
// these to drive the routine, and the popup reads/writes them from the
// Settings view — one typed shape and one set of defaults, so the two sides
// cannot disagree about what a key means or defaults to.

// Referenced type-only by STREAKS (below) for its activities keys — a
// compile-time, one-way reference to the storage schema, no runtime coupling.
import type { Stats } from './storage.ts'
import { normalizeSettings, validateSettings } from './settings-validation.ts'

export type TabCloseMode = 'perStep' | 'routine'
export type Appearance = 'light' | 'dark' | 'auto'
export type ThemeName = 'catppuccin' | 'geist' | 'primer' | 'nord' | 'dracula' | 'tokyo' | 'gruvbox' | 'rose'
// The popup backdrop — see popup/fx/Background.tsx (the dispatcher) and
// theme/backgrounds.css. Grouped by feel:
//   drifting / glowing:  aurora (blob mesh), bokeh (soft circles), fireflies
//                        (wandering glows), swirl (rotating conic), glow
//   traveling light:     beams (along SVG paths), rays (sweeping god rays),
//                        spotlight (a searching beam)
//   falling / rising:    meteors (diagonal streaks), snow (slow flakes),
//                        rain (fast streaks), bubbles (rising)
//   fields:              stars (twinkle), dots (matrix + sheen), grid, hex,
//                        checker, stripes (scrolling), mesh (fixed radials)
//   pulsing:             ripple (expanding rings), orbit (circling dots),
//                        retro (perspective floor scroll), noise (film grain)
//   flowing:             waves (parallax wave layers)
//   interactive:         cursor (glow chasing the pointer), particles (dots
//                        repelled by it), parallax (depth orbs), constellation
//                        (a node web linking to it)
//   none: flat panel.
export type BackgroundStyle =
  | 'aurora'
  | 'bokeh'
  | 'fireflies'
  | 'swirl'
  | 'glow'
  | 'beams'
  | 'rays'
  | 'spotlight'
  | 'meteors'
  | 'snow'
  | 'rain'
  | 'bubbles'
  | 'waves'
  | 'stars'
  | 'dots'
  | 'grid'
  | 'hex'
  | 'checker'
  | 'stripes'
  | 'mesh'
  | 'ripple'
  | 'orbit'
  | 'retro'
  | 'noise'
  | 'cursor'
  | 'particles'
  | 'parallax'
  | 'constellation'
  | 'none'

// The startup step ids, in their canonical default order (the stats read
// leads so the numbers reflect the day before the steps churn the dashboard;
// claim is early so pending points land before the verdicts judge).
export type StepId = 'stats' | 'claim' | 'dailySet' | 'keepEarning' | 'search' | 'imageSearch'

export interface Settings {
  startupEnabled: boolean // Master switch for the whole startup sequence
  startupOncePerDay: boolean // Skip the routine if it already ran today
  confirmBeforeRoutine: boolean // Ask before the startup routine starts
  statsStartupEnabled: boolean // Stats step (the routine's opening read)
  claimStartupEnabled: boolean // Claim step
  dailySetStartupEnabled: boolean // Daily set step
  keepEarningStartupEnabled: boolean // Keep earning step
  searchStartupEnabled: boolean // Web search step
  imageSearchStartupEnabled: boolean // Image search step
  startupOrder: StepId[] // Sequence of the startup steps (drag-reordered)
  sectionOrder: string[] // Order of the popup's tabs (popup only)
  querySourceOrder: string[] // Query-source preference order
  searchesPerBatch: number // How many searches per batch
  rightSizeSearchBatch: boolean // Trim the batch to the day's remaining points
  randomSearchEnabled: boolean // The prowl: 2-5 background searches inside the interval window
  prowlMinIntervalMin: number // Prowl: shortest wait between rounds, minutes
  prowlMaxIntervalMin: number // Prowl: longest wait between rounds, minutes
  minDelaySec: number // Min delay between searches (seconds)
  maxDelaySec: number // Max delay between searches (seconds)
  tabCloseMode: TabCloseMode // "perStep" vs one sweep at routine end
  closeTabsAfterManualRun: boolean
  closeTabsAfterClaim: boolean
  closeTabsAfterDailySet: boolean
  closeTabsAfterKeepEarning: boolean
  closeTabsAfterSearch: boolean
  closeTabsAfterImageSearch: boolean
  tabCloseDelaySec: number // Grace period so the page can be credited
  keepPinnedTabs: boolean // Never close a tab the user pinned
  dailySetMaxTiles: number
  keepEarningMaxTiles: number // 0 = however many are there today
  scheduledRunEnabled: boolean // The scheduled daily run (Phase 2 wiring)
  scheduledRunTime: string // local "HH:MM", 24-hour
  quietHoursEnabled: boolean
  quietHoursStart: string
  quietHoursEnd: string
  restockWatcherEnabled: boolean // The restock watcher (Phase 2 wiring)
  restockIntervalMin: number
  redeemGoalPts: number // The Today view's points goal (0 = none)
  animationsEnabled: boolean // Popup motion (also gated on reduced-motion)
  lowPowerMode: boolean // One switch for everything that moves: overrides animationsEnabled, backdrops go static
  mouseEscapeEnabled: boolean // The troll: controls dodge the cursor (Settings is exempt)
  theme: ThemeName // Popup palette
  background: BackgroundStyle // Popup backdrop style
  backgroundBrightness: number // Backdrop brightness, in % (100 = as drawn)
  tileBlur: number // Glass blur of the cards over the backdrop, in px
  topBarBackground: boolean // Block scrolling content behind the floating header
  bottomBarBackground: boolean // Block scrolling content behind the floating bottom controls
  accentColor: string // Explicit brand color overriding the theme's ("" = theme)
  appearance: Appearance // light/dark/auto
  refreshStatsOnPopupOpen: boolean // Re-read stats on popup open
  popupHeight: number // 240–600; 0 = auto
  hiddenSections: string[] // Tabs hidden via the layout editor
  developerOptionsEnabled: boolean // The Activity view's dev gate
  experimentalFeatures: boolean // Experimental features gate
}

// These defaults are captured from the maintainer's own live configuration
// (6.9.4, "set the defaults to my current settings"): a fresh install — or a
// settings reset — now starts from a known-good, real-world setup. The inline
// notes below flag values that carry a rationale beyond "this is what was set".
export const DEFAULT_SETTINGS: Settings = {
  // On: the routine runs on browser launch (once-per-day + confirm still gate it).
  startupEnabled: true,
  startupOncePerDay: true,
  confirmBeforeRoutine: true,
  statsStartupEnabled: true,
  claimStartupEnabled: true,
  dailySetStartupEnabled: true,
  keepEarningStartupEnabled: true,
  searchStartupEnabled: true,
  imageSearchStartupEnabled: true,
  startupOrder: ['stats', 'dailySet', 'keepEarning', 'imageSearch', 'search', 'claim'],
  sectionOrder: ['today', 'runNow', 'redeem', 'activity'],
  querySourceOrder: ['bingAutosuggest', 'googleTrends', 'wikipedia', 'uselessFacts', 'local'],
  searchesPerBatch: 30,
  rightSizeSearchBatch: true,
  // The prowl is on by default — "on all the time, can be turned off" is the
  // feature's spec (user request, 2026-09-09).
  randomSearchEnabled: true,
  // 15–45 min stays the default window; the user can widen or narrow it.
  prowlMinIntervalMin: 15,
  prowlMaxIntervalMin: 45,
  minDelaySec: 5,
  maxDelaySec: 15,
  tabCloseMode: 'perStep',
  closeTabsAfterManualRun: true,
  closeTabsAfterClaim: true,
  closeTabsAfterDailySet: true,
  closeTabsAfterKeepEarning: true,
  closeTabsAfterSearch: true,
  closeTabsAfterImageSearch: true,
  tabCloseDelaySec: 4,
  keepPinnedTabs: true,
  dailySetMaxTiles: 3,
  keepEarningMaxTiles: 0,
  scheduledRunEnabled: false,
  scheduledRunTime: '00:20',
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
  restockWatcherEnabled: false,
  restockIntervalMin: 120,
  redeemGoalPts: 0,
  animationsEnabled: true,
  // Off by default (user request, 2026-09-11): flipping it must be a
  // deliberate save-every-cycle choice, not a fresh-install surprise.
  lowPowerMode: false,
  // Off — matches the maintainer's saved configuration (the 6.9.4 capture).
  mouseEscapeEnabled: false,
  theme: 'tokyo',
  // Default backdrop is the cursor glow with fully clear tiles (blur 0),
  // matching the maintainer's saved configuration (the 6.9.4 capture).
  background: 'cursor',
  backgroundBrightness: 100,
  tileBlur: 0,
  topBarBackground: false,
  bottomBarBackground: false,
  accentColor: '#8b5cf6',
  appearance: 'auto',
  refreshStatsOnPopupOpen: false,
  popupHeight: 600,
  hiddenSections: [],
  developerOptionsEnabled: false,
  experimentalFeatures: false,
}

// A stored settings blob wins key by key over the defaults, so a value the
// user set survives and a key an update adds falls back to its default.
export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.sync.get('settings')
  return normalizeSettings(settings, DEFAULT_SETTINGS)
}

// Merge a patch into the stored settings (the popup's writes). Read-merge-write
// so a partial update never drops the keys it didn't touch.
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  // Web Locks serialize saves across the popup and dashboard, not just within
  // one React tree. Read inside the lock so every patch sees the last write.
  const captured = validateSettings(structuredClone(patch), DEFAULT_SETTINGS, true)
  return navigator.locks.request('zoomies-settings', async () => {
    const current = await getSettings()
    const next = { ...current, ...captured }
    await chrome.storage.sync.set({ settings: next })
    return next
  })
}

// The startup steps' shared display constants — one source, so the popup's
// plan preview, the Settings toggles, the dashboard's Next-routine tile, and
// the routine-done summary can never name a step differently or bind the
// wrong toggle. (The worker's activity-log labels are their own lowercase
// map in background/core/log.ts — different words, on purpose.)
export const STEP_LABEL: Record<StepId, string> = {
  stats: 'Read stats',
  claim: 'Claim points',
  dailySet: 'Daily set',
  keepEarning: 'Keep earning',
  search: 'Web searches',
  imageSearch: 'Image search',
}

// The Settings boolean each step's startup toggle flips — the plan preview
// reads it to know which steps are enabled, the Settings view binds the
// switches to it.
export const ENABLED_KEY: Record<StepId, keyof Settings> = {
  stats: 'statsStartupEnabled',
  claim: 'claimStartupEnabled',
  dailySet: 'dailySetStartupEnabled',
  keepEarning: 'keepEarningStartupEnabled',
  search: 'searchStartupEnabled',
  imageSearch: 'imageSearchStartupEnabled',
}

// The four Rewards streak cards, in the order the Earn page lists them. The
// label is the card's title; the raw display string ("Day 4 of 7 · 1/1")
// comes from stats.activities[key]. Shared by the popup's Today card and the
// dashboard's Streaks tile.
export const STREAKS: { key: keyof Stats['activities']; label: string }[] = [
  { key: 'bingSearch', label: 'Bing search' },
  { key: 'dailySet', label: 'Daily set' },
  { key: 'bingApp', label: 'Bing app' },
  { key: 'visualSearch', label: 'Image search' },
]
