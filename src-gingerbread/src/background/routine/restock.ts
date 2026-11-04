import { getSettings } from '../../shared/settings.ts'
import { getLocal, KEYS } from '../../shared/storage.ts'
import type { RedeemRead, StockNews } from '../../shared/storage.ts'
import { readRunState } from '../core/run-state.ts'
import { checkRedeemAvailability } from '../readers/redeem.ts'
import { READ_RUN_GUARDS } from '../readers/stats.ts'
import { inQuietHours } from '../pure/run-tools.ts'

export const RESTOCK_ALARM = 'restockWatch'
let checking = false

export async function ensureRestockScheduled(): Promise<void> {
  const settings = await getSettings()
  const alarm = await chrome.alarms.get(RESTOCK_ALARM)
  if (!settings.restockWatcherEnabled) {
    if (alarm) await chrome.alarms.clear(RESTOCK_ALARM)
    return
  }
  const minutes = Math.max(30, Math.min(1440, Number(settings.restockIntervalMin) || 120))
  if (!alarm || alarm.periodInMinutes !== minutes) {
    await chrome.alarms.create(RESTOCK_ALARM, { delayInMinutes: minutes, periodInMinutes: minutes })
  }
}

export async function restockFire(): Promise<void> {
  if (checking) return
  checking = true
  try {
    const settings = await getSettings()
    const state = await readRunState()
    const stopEpoch = state.stopEpoch
    if (!settings.restockWatcherEnabled || inQuietHours(settings) || state.batch || state.routine || state.activity ||
        READ_RUN_GUARDS.redeem || READ_RUN_GUARDS.stats || READ_RUN_GUARDS.orders) return
    const startedAt = Date.now()
    await checkRedeemAvailability()
    const currentSettings = await getSettings()
    if (!currentSettings.restockWatcherEnabled || inQuietHours(currentSettings) || (await readRunState()).stopEpoch !== stopEpoch) return
    const catalog = await getLocal<RedeemRead>(KEYS.lastRedeem)
    if (!catalog?.at || catalog.at < startedAt) return
    const news = await getLocal<StockNews>(KEYS.redeemRestockNews)
    const notified = await getLocal<number>(KEYS.restockNotifiedAt)
    if (!news?.labels?.length || !Number.isFinite(news.at) || news.at < startedAt || news.at <= (Number(notified) || 0)) return
    await chrome.notifications.create('gingerbread-restock', {
      type: 'basic', iconUrl: 'icons/icon128.png', title: 'Reward back in stock',
      message: news.labels.slice(0, 6).join(', '),
    })
    await chrome.storage.local.set({ [KEYS.restockNotifiedAt]: news.at })
  } finally {
    checking = false
  }
}
