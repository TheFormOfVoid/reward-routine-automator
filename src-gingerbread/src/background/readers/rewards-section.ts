// The Rewards-section runner — the daily set and the keep-earning steps.
// The two sections differ only in what they are called, how many tiles they
// hold and where they are most likely to be found, so they share one runner
// and one injected finder.

import { beginActivity, endActivity, currentStopEpoch } from '../core/run-state.ts'
import { sleep } from '../core/delays.ts'
import { beginTabCapture, claimTab, closeCapturedTabs, waitForTabComplete } from '../core/tabs.ts'
import { setLastRewards } from '../core/log.ts'
import { getSettings } from '../../shared/settings.ts'
import type { Settings } from '../../shared/settings.ts'
import { openRewardsSectionTiles } from '../injections/rewards-tiles.ts'
import { withDeadline } from '../pure/search-recovery.ts'
import { createNormalTab } from '../core/normal-tabs.ts'
import { holdKeepAlive, releaseKeepAlive } from '../core/keepalive.ts'

// Both Rewards entry points serve the same app, but which section renders on
// which has moved around — so each section carries its own order of URLs to try
// rather than the whole feature betting on one.
export const REWARDS_DASHBOARD = 'https://rewards.bing.com/dashboard'
export const REWARDS_EARN = 'https://rewards.bing.com/earn'

type SectionId = 'dailySet' | 'keepEarning'

interface RewardsSection {
  label: string
  // Matched case-insensitively against the headings on the page.
  names: string[]
  maxKey: keyof Settings
  closeKey: keyof Settings
  urls: string[]
  skipSpent?: boolean
}

export const REWARDS_SECTIONS: Record<SectionId, RewardsSection> = {
  dailySet: {
    label: 'Daily set',
    names: ['daily set', 'daily sets'],
    maxKey: 'dailySetMaxTiles',
    closeKey: 'closeTabsAfterDailySet',
    urls: [REWARDS_DASHBOARD, REWARDS_EARN],
  },
  keepEarning: {
    label: 'Keep earning',
    names: ['keep earning', 'more activities', 'more ways to earn'],
    maxKey: 'keepEarningMaxTiles',
    closeKey: 'closeTabsAfterKeepEarning',
    urls: [REWARDS_EARN, REWARDS_DASHBOARD],
    // Tiles that are completed or "reward up only" are skipped outright instead
    // of the conservative blind-click the daily set keeps — see
    // openRewardsSectionTiles.
    skipSpent: true,
  },
}

export function openDailySetOnRewardsDashboard(): Promise<void> {
  return runRewardsSection('dailySet')
}

export function openKeepEarningActivities(): Promise<void> {
  return runRewardsSection('keepEarning')
}

async function runRewardsSection(stepId: SectionId): Promise<void> {
  const section = REWARDS_SECTIONS[stepId]
  const settings = await getSettings()

  // 0, blank or unreadable means "open however many are there" — which is the
  // point for Keep earning, where the number of activities changes daily.
  const configured = Math.floor(Number(settings[section.maxKey]))
  const maxTiles = Number.isFinite(configured) && configured > 0 ? configured : 0

  // Marks this run as the current activity so the popup's Stop button covers
  // it too; the returned epoch tells this run when it has been stopped.
  const myEpoch = await beginActivity(section.label)
  const stopped = (): Promise<boolean> => currentStopEpoch().then((v) => v !== myEpoch)

  // From here until closeCapturedTabs() below, every new tab is attributed to
  // this step — which is how the tabs the tiles open get cleaned up too.
  await beginTabCapture(stepId)
  holdKeepAlive()

  try {
    const rewardsTab = await withDeadline(createNormalTab(section.urls[0]), 10000, 'Rewards tab opening')
    const rewardsTabId = rewardsTab.id
    if (rewardsTabId == null) {
      await setLastRewards(`${section.label} — could not open the Rewards tab`, false)
      return
    }
    await claimTab(stepId, rewardsTabId)

    // A stop that landed while the tab was opening. Stopping is not finishing:
    // the tab stays open, the injection never runs, and the stopped report
    // below replaces the normal one.
    let halted = false
    if (await stopped()) {
      await setLastRewards(`${section.label} — stopped`, false)
      halted = true
    }

    // -1 means the page stopped being readable, which a tile click can cause by
    // navigating it away mid-script. That counts as done, not as "nothing here".
    let opened = -1

    for (let i = 0; i < section.urls.length; i++) {
      if (!halted && (await stopped())) {
        await setLastRewards(`${section.label} — stopped`, false)
        halted = true
      }
      if (halted) break

      if (i > 0) {
        console.log(`${section.label}: nothing on the last page, trying ${section.urls[i]}.`)
        try {
          await chrome.tabs.update(rewardsTabId, { url: section.urls[i] })
        } catch (e) {
          console.warn(`${section.label}: could not navigate to the fallback:`, e)
          break
        }
      }

      const loaded = await waitForTabComplete(rewardsTabId)
      if (!loaded) {
        console.warn(`${section.label}: page did not finish loading in time.`)
      }

      // Stop checkpoint after the load wait: the injection (and its tile
      // clicks) is the part a stop is meant to prevent.
      if (await stopped()) {
        await setLastRewards(`${section.label} — stopped`, false)
        halted = true
        break
      }

      opened = -1
      try {
        const [injection] = await withDeadline(chrome.scripting.executeScript({
          target: { tabId: rewardsTabId },
          func: openRewardsSectionTiles,
          args: [section.names, maxTiles, section.label, section.skipSpent === true,
            { stopEpoch: myEpoch, expiresAt: Date.now() + 40000 }],
        }), 45000, 'Rewards tile reader')
        const value = injection && injection.result
        opened = typeof value === 'number' ? value : -1
      } catch (e) {
        console.warn(`${section.label} injection ended early:`, e)
      }

      // Only a definite zero means "this section is not on this page".
      if (await stopped()) { halted = true; await setLastRewards(`${section.label} — stopped`, false); break }
      if (opened !== 0) break
    }

    // The stopped report replaces the normal one, and a stopped run does not
    // sit out the post-click grace sleep.
    if (!halted) {
      await reportRewardsRun(section.label, opened)
      await sleep(3000)
    }
  } finally {
    // A no-op after a stop: the stop write cleared the capture bookkeeping, so
    // the tabs stay open.
    try {
      await closeCapturedTabs(stepId, section.closeKey)
      await endActivity(section.label)
    } finally { releaseKeepAlive() }
  }
}

async function reportRewardsRun(label: string, opened: number): Promise<void> {
  if (opened > 0) {
    const noun = opened === 1 ? 'activity' : 'activities'
    await setLastRewards(`${label} — opened ${opened} ${noun}`, true)
  } else if (opened === 0) {
    await setLastRewards(`${label} — no activities found`, false)
  } else {
    // Tiles were clicked; the page moved on before they could be counted.
    await setLastRewards(`${label} — ran, count unavailable`, null)
  }
}
