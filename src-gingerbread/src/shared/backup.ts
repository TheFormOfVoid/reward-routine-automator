import { DEFAULT_SETTINGS } from './settings.ts'
import type { Settings } from './settings.ts'
import { validateSettings } from './settings-validation.ts'
import { withActivityLock } from './activity-lock.ts'
import { normalizeWidgets, WIDGETS } from '../popup/lib/widget-layout.ts'
import { PANEL_IDS } from '../pages/dashboard/tiles/registry.ts'

export const BACKUP_LIMIT_BYTES = 2 * 1024 * 1024
export const BACKUP_KEYS = ['pointsHistory', 'redeemHistory', 'dashLayout', 'popupWidgetLayout', 'dashHiddenWidgets', 'recentQueries', 'runHistory'] as const
export const RESTORE_BACKUP_KEY = 'gingerbreadBeforeRestore'
type Data = Record<string, unknown>
export interface BackupDocument {
  format: 'gingerbread-backup'
  schemaVersion: 1
  createdAt: string
  extensionVersion: string
  settings: Partial<Settings>
  data: Data
}
const plain = (value: unknown): value is Data => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
const shortString = (value: unknown, max = 2000) => typeof value === 'string' && value.length <= max
const STEPS = ['stats', 'claim', 'dailySet', 'keepEarning', 'search', 'imageSearch']
const OUTCOMES = ['started', 'skipped', 'paused', 'resumed', 'action-finished', 'failed', 'completed', 'incomplete', 'unknown', 'cancelled', 'retry', 'submitted', 'observed']
const storedSettings = (value: unknown): Data => {
  if (value === undefined) return {}
  if (!plain(value)) throw new Error('Saved settings could not be read safely. Try again before restoring.')
  return value
}
export function validateBackupSettings(value: unknown): Partial<Settings> {
  return validateSettings(value, DEFAULT_SETTINGS, true)
}

function validateData(key: string, value: unknown): void {
  const list = Array.isArray(value) ? value : null
  if (key === 'recentQueries') {
    if (!list || list.length > 200 || !list.every((v) => shortString(v, 200))) throw new Error('Invalid recent query history.')
  } else if (key === 'pointsHistory') {
    if (!list || list.length > 60 || !list.every((v) => plain(v) && /^\d{4}-\d{2}-\d{2}$/.test(String(v.day)) && finite(v.first) && finite(v.last) && (v.at == null || finite(v.at)))) throw new Error('Invalid points history.')
  } else if (key === 'redeemHistory') {
    if (!list || list.length > 500 || !list.every((v) => plain(v) && finite(v.at) && shortString(v.day, 10) && shortString(v.label, 200) && typeof v.available === 'boolean')) throw new Error('Invalid stock history.')
  } else if (key === 'runHistory') {
    if (!list || list.length > 30 || !list.every((v) => plain(v) && shortString(v.id, 100) && finite(v.startedAt) && (v.endedAt == null || finite(v.endedAt)) && ['startup', 'scheduled', 'manual', 'remaining-work'].includes(String(v.source)) && Array.isArray(v.events) && v.events.length <= 100 && v.events.every((event) => plain(event) && finite(event.at) && [...STEPS, 'routine', 'stats/full', 'stats/search'].includes(String(event.step)) && OUTCOMES.includes(String(event.outcome)) && shortString(event.detail, 240) && (event.durationMs == null || finite(event.durationMs))) && Array.isArray(v.steps) && v.steps.length <= 30 && v.steps.every((step) => STEPS.includes(String(step))) && ['running', 'completed', 'incomplete', 'unknown', 'cancelled'].includes(String(v.status)) && (v.detail == null || shortString(v.detail, 240)) && (v.beforePoints == null || finite(v.beforePoints)) && (v.afterPoints == null || finite(v.afterPoints)))) throw new Error('Invalid routine history.')
  } else if (key === 'lastOrders') {
    if (!plain(value) || !finite(value.at) || !finite(value.total) || !Array.isArray(value.orders) || value.orders.length > 1000 || !value.orders.every((v) => plain(v) && shortString(v.title) && ['points', 'date', 'orderNo', 'code', 'expires', 'status'].every((key) => v[key] == null || shortString(v[key])))) throw new Error('Invalid order history.')
  } else if (key === 'dashLayout') {
    if (!plain(value)) throw new Error('Invalid dashboard layout.')
    const modern = value.v === 2 && Array.isArray(value.items) && value.items.length <= 50 && value.items.every((v) => plain(v) && shortString(v.i, 50) && ['x', 'y', 'w', 'h'].every((k) => finite(v[k]) && Number(v[k]) >= 0 && Number(v[k]) <= 10000))
    const legacy = Array.isArray(value.order) && value.order.length <= 50 && value.order.every((v) => shortString(v, 50)) && plain(value.span) && plain(value.rows)
    const columns = Array.isArray(value.columns) && value.columns.length <= 12 && value.columns.every((c) => Array.isArray(c) && c.length <= 50 && c.every((v) => shortString(v, 50)))
    if (!modern && !legacy && !columns) throw new Error('Unsupported dashboard layout.')
  } else if (key === 'popupWidgetLayout') {
    if (!plain(value) || value.v !== 1 || !Array.isArray(value.items) || value.items.length > WIDGETS.length || Object.keys(value).some(key => !['v', 'items'].includes(key)) || value.items.some(item => !plain(item) || Object.keys(item).some(key => !['id', 'size'].includes(key)))) throw new Error('Invalid popup widget layout.')
    const normalized = normalizeWidgets(value)
    const items = value.items as { id?: unknown; size?: unknown }[]
    if (normalized.length !== items.length || normalized.some((item, index) => item.id !== items[index].id || item.size !== items[index].size)) throw new Error('Unsupported popup widget layout.')
  } else if (key === 'dashHiddenWidgets') {
    if (!list || list.length > PANEL_IDS.length || new Set(list).size !== list.length || list.some(id => !PANEL_IDS.includes(id as typeof PANEL_IDS[number]))) throw new Error('Invalid dashboard widget visibility.')
  }
}

function validateJson(value: unknown, depth = 0): void {
  if (depth > 15) throw new Error('The backup contains data nested too deeply.')
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value === 'string' && value.length <= 20000) return
  if (Array.isArray(value)) { for (const item of value) validateJson(item, depth + 1); return }
  if (plain(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('The backup contains an unsupported object property.')
      validateJson(item, depth + 1)
    }
    return
  }
  throw new Error('The backup contains an unsupported data value.')
}

export function parseBackup(text: string): BackupDocument {
  if (new TextEncoder().encode(text).length > BACKUP_LIMIT_BYTES) throw new Error('Choose a backup smaller than 2 MB.')
  let input: unknown
  try { input = JSON.parse(text) } catch { throw new Error('This file is not valid JSON.') }
  validateJson(input)
  if (!plain(input) || input.format !== 'gingerbread-backup' || input.schemaVersion !== 1) throw new Error('Choose a supported Gingerbread backup (version 1).')
  if (!shortString(input.createdAt, 50) || !Number.isFinite(Date.parse(String(input.createdAt))) || !shortString(input.extensionVersion, 30) || !plain(input.data)) throw new Error('The backup header is incomplete.')
  const settings = validateBackupSettings(input.settings)
  const data: Data = {}
  for (const [key, value] of Object.entries(input.data)) {
    if (![...BACKUP_KEYS, 'lastOrders'].includes(key)) throw new Error(`This backup contains an unsupported data section: ${key}.`)
    validateData(key, value)
    data[key] = value
  }
  return { format: 'gingerbread-backup', schemaVersion: 1, createdAt: String(input.createdAt), extensionVersion: String(input.extensionVersion), settings, data }
}

export function createBackup(settings: unknown, local: Data, extensionVersion: string, includeOrders = false): BackupDocument {
  const data: Data = {}
  for (const key of [...BACKUP_KEYS, ...(includeOrders ? ['lastOrders'] : [])]) {
    if (local[key] !== undefined) data[key] = structuredClone(local[key])
  }
  return parseBackup(JSON.stringify({ format: 'gingerbread-backup', schemaVersion: 1, createdAt: new Date().toISOString(), extensionVersion, settings, data }))
}

export function mergedBackupData(current: Data, incoming: Data, replace: boolean): Data {
  const next: Data = {}
  for (const [key, value] of Object.entries(incoming)) {
    // Layout/visibility are complete choices, not append-only histories. An
    // imported empty visibility list intentionally makes all panels visible.
    if (key === 'popupWidgetLayout' || key === 'dashHiddenWidgets') {
      next[key] = structuredClone(value)
      continue
    }
    if (!replace && key === 'lastOrders' && plain(value) && plain(current[key])) {
      const old = current[key] as Data
      const currentOrders = Array.isArray(old.orders) ? old.orders : []
      const importedOrders = Array.isArray(value.orders) ? value.orders : []
      const identity = (row: Data) => String(row.orderNo || `${row.title}:${row.date}:${row.points}`)
      const orders = new Map<string, Data>()
      for (const row of [...importedOrders, ...currentOrders]) {
        if (!plain(row)) continue
        const previous = orders.get(identity(row))
        orders.set(identity(row), { ...previous, ...row, code: row.code || previous?.code || null })
      }
      next[key] = { ...value, ...old, at: Math.max(Number(old.at) || 0, Number(value.at) || 0), total: Math.max(Number(old.total) || 0, Number(value.total) || 0, orders.size), orders: [...orders.values()].slice(0, 1000) }
      continue
    }
    if (replace || !Array.isArray(value) || !Array.isArray(current[key])) { next[key] = structuredClone(value); continue }
    const old = current[key] as unknown[]
    const all = [...old, ...value]
    const identity = (v: unknown) => {
      if (!plain(v)) return String(v).toLowerCase()
      return key === 'pointsHistory' ? String(v.day) : key === 'runHistory' ? String(v.id) : `${v.at}:${v.label}`
    }
    // Merge preserves an existing day's snapshot/run with the same identity.
    // Replace is the explicit way to overwrite those records.
    const merged = new Map<string, unknown>()
    for (const item of all) if (!merged.has(identity(item))) merged.set(identity(item), item)
    const cap = key === 'pointsHistory' ? 60 : key === 'redeemHistory' ? 500 : key === 'runHistory' ? 30 : 200
    const items = [...merged.values()]
    if (key === 'pointsHistory') items.sort((a, b) => String((a as Data).day).localeCompare(String((b as Data).day)))
    else if (key !== 'recentQueries') items.sort((a, b) => (key === 'runHistory' ? -1 : 1) * (Number((a as Data).startedAt || (a as Data).at) - Number((b as Data).startedAt || (b as Data).at)))
    next[key] = key === 'recentQueries' || key === 'runHistory' ? items.slice(0, cap) : items.slice(-cap)
  }
  return next
}

export async function readBackup(includeOrders = false): Promise<BackupDocument> {
  const [sync, local] = await Promise.all([chrome.storage.sync.get('settings'), chrome.storage.local.get([...BACKUP_KEYS, ...(includeOrders ? ['lastOrders'] : [])])])
  return createBackup({ ...DEFAULT_SETTINGS, ...storedSettings(sync.settings) }, local, chrome.runtime.getManifest().version, includeOrders)
}

export async function restoreBackup(backup: BackupDocument, replace: boolean, includeOrders: boolean): Promise<void> {
  // The same cross-page settings lock used by normal saves prevents an import
  // from losing a simultaneous preference edit in another extension surface.
  await withActivityLock(() => navigator.locks.request('zoomies-settings', async () => {
    const [sync, local] = await Promise.all([chrome.storage.sync.get('settings'), chrome.storage.local.get([...BACKUP_KEYS, 'lastOrders', 'runState', 'activeRun'])])
    const run = local.runState
    if ((plain(run) && (run.routine || run.batch || run.activity)) || local.activeRun) throw new Error('Stop the current activity before restoring a backup.')
    const validated = parseBackup(JSON.stringify(backup))
    const incoming = { ...validated.data }
    if (!includeOrders) delete incoming.lastOrders
    const before = createBackup({ ...DEFAULT_SETTINGS, ...storedSettings(sync.settings) }, local, chrome.runtime.getManifest().version, true)
    await chrome.storage.local.set({ [RESTORE_BACKUP_KEY]: before })
    const settings = replace ? { ...DEFAULT_SETTINGS, ...validated.settings } : { ...DEFAULT_SETTINGS, ...storedSettings(sync.settings), ...validated.settings }
    try {
      await chrome.storage.sync.set({ settings })
      await chrome.storage.local.set(mergedBackupData(local, incoming, replace))
    } catch (error) {
      // Multi-area storage has no transaction. Restore the saved values after
      // a partial failure and keep the recovery document even if rollback fails.
      try {
        await chrome.storage.sync.set({ settings: before.settings })
        await chrome.storage.local.set(before.data)
        const introduced = Object.keys(incoming).filter((key) => local[key] === undefined)
        if (introduced.length) await chrome.storage.local.remove(introduced)
      } catch { throw new Error('Restore failed. A recovery backup is saved; download it before trying again.') }
      throw error
    }
  }))
}

export function downloadBackup(backup: BackupDocument, prefix = 'Gingerbread backup'): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${prefix} ${new Date().toISOString().slice(0, 10)}.json`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
