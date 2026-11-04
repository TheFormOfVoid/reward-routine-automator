// Select a tab inside an existing normal browser window. Selecting a tab does
// not focus its OS window; never create a popup/window or call windows.update.
export async function createNormalTab(url: string, active = true): Promise<chrome.tabs.Tab> {
  const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
  if (window.id == null || window.type !== 'normal') throw new Error('No normal browser window is available')
  return chrome.tabs.create({ windowId: window.id, url, pinned: false, active })
}
