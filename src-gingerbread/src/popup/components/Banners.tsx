import { sendMessage } from '../../shared/messages.ts'
import { localDayKey } from '../../background/core/day.ts'
import type { Stats, StockNews } from '../../shared/storage.ts'
import { usePendingUpdate } from '../hooks/usePendingUpdate.ts'
import { useRestockNews, useSoldOutNews } from '../hooks/useRedeem.ts'
import { RestartIcon } from './icons.tsx'
import { DismissibleNotice } from './NotificationCard.tsx'

function NewsBanner({ news, kind, prefix, tone, preview }: {
  news: StockNews | null; kind: 'restock' | 'soldOut'; prefix: string; tone: 'good' | 'warn'; preview: boolean
}) {
  const labels = news && Array.isArray(news.labels) ? news.labels : []
  if (!labels.length) return null
  return <DismissibleNotice key={preview ? 'preview' : 'live'} kind={kind} fingerprint={JSON.stringify([news?.at, labels])} preview={preview}
    dismissLabel={`Dismiss ${kind === 'restock' ? 'restock' : 'sold-out'} notification`} tone={tone}>
    {prefix}{labels.join(', ')}.
  </DismissibleNotice>
}

function UpdateBanner() {
  const pending = usePendingUpdate()
  if (!pending) return null
  return <DismissibleNotice kind="update" fingerprint={pending} dismissLabel="Dismiss update notification" tone="update">
    <span>Updated to {pending} — restart to apply.</span>
    <button type="button" className="banner-btn" onClick={() => sendMessage({ type: 'RELOAD_EXTENSION' })}>
      <RestartIcon aria-hidden="true" /> Restart
    </button>
  </DismissibleNotice>
}

export function Banners({ stats, preview }: { stats: Stats | null; preview: boolean }) {
  const restock = useRestockNews()
  const soldOut = useSoldOutNews()
  const match = String(stats?.activities?.bingApp || '').match(/(\d+)\s*\/\s*(\d+)\s*$/)
  const appStalled = preview || (!!match && Number(match[1]) === 0 && Number(match[2]) > 0)
  return <div className="banners">
    <UpdateBanner />
    {appStalled && <DismissibleNotice key={preview ? 'preview' : 'live'} kind="bingApp" fingerprint={localDayKey()} preview={preview}
      dismissLabel="Dismiss Bing app notification" tone="danger"
      title="This one only counts from the Bing phone app — the routine can’t finish it for you.">
      Bing app check-in not done yet today.
    </DismissibleNotice>}
    <NewsBanner kind="restock" news={preview ? { at: 0, labels: ['500 coins'] } : restock}
      prefix="Overwatch coins available: " tone="good" preview={preview} />
    <NewsBanner kind="soldOut" news={preview ? { at: 0, labels: ['2000 coins'] } : soldOut}
      prefix="No longer available: " tone="warn" preview={preview} />
  </div>
}
