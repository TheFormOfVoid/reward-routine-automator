// The stored-data contract, shared by the worker and the popup. Every shape
// the extension persists is typed here in one place, so a reader that writes
// `lastStats` and a hook that renders it cannot drift apart. The keys mirror
// the earlier builds exactly (lastStats, lastRoutineDay, pointsHistory, the
// five log rows) — the fifth build is a rewrite of the code, not of the
// storage schema, so an account mid-routine keeps its history and marks.

// ---------- storage.local documents ----------

// The four Rewards streak values a read reports, each the raw display string
// ("Day 4 of 7 · 1/1") or null when the page didn't answer for it.
export interface Activities {
  bingSearch: string | null
  dailySet: string | null
  bingApp: string | null
  visualSearch: string | null
}

// The Keep-earning section's verdict counts, read by the stats read from the
// Earn page: `open` is how many tiles the keep-earning step would still click
// (not completed, not "reward up only"), `total` how many usable tiles the
// section holds at all. null/absent — the section wasn't found or didn't
// answer — is never a verdict, only "unknown".
export interface KeepEarningCounts {
  open: number
  total: number
}

// The merged stats read (lastStats): the dashboard's top cards + the Earn
// page's streak cards, combined by pure/merge-stats. `at` is the read's
// timestamp — statsAreCurrent gates every verdict on it being today's.
export interface Stats {
  at?: number
  availablePoints: string | null
  readyToClaim: string | null
  dailyStreak: string | null
  stampBonus: string | null
  // The membership tier off the header medal ("Gold Member") — optional
  // because it's a header extra, not a card; a miss is a miss, not a block.
  membership?: string | null
  searchPoints: string | null
  activities: Activities
  keepEarning?: KeepEarningCounts | null
}

// A page read before the merge: every field optional, since either page may
// answer for only some of them (the merge fills the gaps).
export type RawStats = {
  availablePoints?: string | null
  readyToClaim?: string | null
  dailyStreak?: string | null
  stampBonus?: string | null
  membership?: string | null
  searchPoints?: string | null
  activities?: Partial<Activities>
  keepEarning?: KeepEarningCounts | null
}

// One day of the points history (pointsHistory): the day's FIRST balance and
// its LAST, so both "earned today" and the trend line come from one list.
export interface HistoryEntry {
  day: string
  first: number
  last: number
  at: number
}

// An Activity-card row (lastTabAction, lastRewards, lastStatsLog, …). `ok`
// tri-states: true good, false failed, null neutral/informational. `dump` is
// the optional ADR-010 evidence markup a reader attaches when a page surprises
// it (shown as the row's hover text).
export interface LogRow {
  detail: string
  ok: boolean | null
  dump?: string
}

// The image search's row carries a timestamp so the popup can dim stale ones.
export interface ImageSearchRow {
  detail: string
  ok: boolean | null
  at: string
}

// The last query typed (lastQuery): which source produced it, and the text.
export interface LastQuery {
  api: string
  text: string
}

// ---------- the redeem watch's documents ----------
//
// Shapes ported from src-donut's redeem watch (readers/redeem.js), typed once here
// so the reader that writes them and the views that render them cannot drift.

// One catalog card from the /redeem search results (readRedeemOptions):
// title/points are the page's display strings, available the tri-state stock
// heuristic (false = marked sold out, true = normal-looking card, null/absent
// = no signal), href the sku link (null for an unpriced duplicate tile).
export interface RedeemOption {
  title: string
  points: string | null
  available: boolean | null
  href: string | null
}

// One coin amount from the sku detail page (readRedeemVariants): "500 coins",
// "1000 coins"… `available` follows the authority chain (RSC payload, then
// the restocking note, then the attribute heuristics), `href` the amount's
// OWN sku page when the payload knew it.
export interface RedeemVariant {
  label: string
  available: boolean
  href?: string
}

// The watch's last good read (lastRedeem): the catalog options, the detail
// page's variants, and the detail URL phase 3 ended on. Each half keeps its
// previous value when a new read comes back empty.
export interface RedeemRead {
  at: number
  query: string
  options: RedeemOption[]
  variants: RedeemVariant[]
  variantUrl: string
}

// The coupon count the stats read picked up off the dashboard's
// "Coupon (N)" trigger (lastCoupons).
export interface CouponsRow {
  at: number
  available: number
}

export interface CouponActionRow {
  at: number
  status: 'checking' | 'applied' | 'none' | 'unverified' | 'failed'
  detail: string
  claimed: number
  attempted: number
}

// One stock-change news record (redeemRestockNews / redeemSoldOutNews): the
// amounts that flipped direction since the previous read. Dismissing its UI
// notice stores a separate acknowledgement; the observation remains intact.
export interface StockNews {
  at: number
  labels: string[]
}

// One point of the redeem history (redeemHistory): the availability of one
// coin amount at one read. The dashboard's per-denomination timeline charts
// these; src-donut never kept them (it stored only the last read) — this is the
// one series the fifth build adds for the full-screen dashboard.
export interface RedeemHistoryEntry {
  at: number
  day: string
  label: string
  available: boolean
  points?: number
}

// One redeemed order off the order-history page (lastOrders): title, points
// and date are the page's display strings ("9,800 pts | 7/31/2026" splits into
// points/date), orderNo the page's own id ("Order no. <uuid>"). The detail
// half — the redemption code, its expiration, the status line — fills in only
// for the orders whose "View detail" dialog the sync opened (the most recent
// few); null/absent means "not read", never "none".
export interface OrderRow {
  title: string
  points: string | null
  date: string | null
  orderNo: string | null
  code?: string | null
  expires?: string | null
  status?: string | null
}

// The order-history sync's document (lastOrders): `total` is the page's own
// "15 results" count (the list may hold fewer rows if it lazy-renders), the
// rows newest-first as the page shows them.
export interface OrdersDoc {
  at: number
  total: number
  orders: OrderRow[]
}

// The dashboard's user-arranged layout (dashLayout, 6.8.0 rewrite): the board
// as react-grid-layout ITEMS — one entry per tile with its seat (x, y) and
// its size (w, h) in grid units, every size one of the tile's designed steps
// (tiles/registry.ts). Written by the dashboard page itself — a pure UI
// preference, never read by the worker. Older shapes — the {order, span,
// rows} flow doc of 6.7.16–6.7.18 and the {columns} masonry doc of
// 6.7.1–6.7.15 — are migrated into v2 items on read (layout/migrate.ts), so
// the user's arrangement survives the engine switch.
export interface DashLayoutItem {
  i: string
  x: number
  y: number
  w: number
  h: number
}
export interface DashLayoutV2 {
  v: 2
  items: DashLayoutItem[]
}

// The 6.7.16–6.7.18 doc: panel ids in grid FLOW order plus per-panel width
// (a span over the 12 columns) and height (a span over the 160px rows).
export interface DashLayoutLegacy {
  order: string[]
  span: Record<string, number>
  rows: Record<string, number>
}

// What may actually sit under the dashLayout key: the current v2 item doc,
// either legacy shape, or nothing (the registry's default board).
export type StoredDashLayout = DashLayoutV2 | DashLayoutLegacy | { columns: string[][] }

// ---------- the run-state document (runState) ----------
//
// ONE document describing exactly "what is running RIGHT NOW" — see
// background/core/run-state.ts for why it is one document and not a dozen keys.

export interface BatchState {
  runId: number
  remaining: number
  tabId: number | null
  nextRunAt: number | null
  retryCount?: number
  attemptId?: number
  attemptStartedAt?: number
  pendingQuery?: { query: string; api: string }
  // Set on a prowl batch (the 15–45-minute background mini-batches): its tabs
  // open in the background, and finishing it must NOT trigger the startup
  // routine's pending steps. Absent on manual/routine batches.
  prowl?: boolean
}

export interface RightSizeRun {
  round: number
  pair: [number, number]
  freshAt?: number
}

export interface SkippedStep {
  id: string
  reason: string
}

export interface RoutineState {
  startDay: string
  pendingSteps: string[]
  pendingTabs: number[]
  skipped: SkippedStep[]
  enabledSteps?: string[]
  recoveryRound?: number
  recoveryProgress?: Record<string, number>
  recovering?: boolean
  ownerUntilAt?: number
  startedAt?: number
  historyId?: string
  recoveryActions?: number
}

export interface Captures {
  capturing: string[]
  opened: Record<string, number[]>
}

export interface RunState {
  v: 1
  batchSequence?: number
  stopEpoch: number
  pause?: { requestedAt: number; effectiveAt?: number }
  activity: { label: string } | null
  batch: BatchState | null
  rightSizeRun: RightSizeRun | null
  routine: RoutineState | null
  captures: Captures
}

export type RunOutcome = 'running' | 'completed' | 'incomplete' | 'unknown' | 'cancelled'
export interface RunEvent {
  at: number
  step: string
  outcome: string
  detail: string
  durationMs?: number
}
export interface RunRecord {
  id: string
  source: string
  startedAt: number
  endedAt?: number
  status: RunOutcome
  steps: string[]
  events: RunEvent[]
  beforePoints?: number
  afterPoints?: number
  detail?: string
}

// ---------- key names ----------
//
// Everything the worker persists outside the run-state document keeps its own
// key. These deliberately SURVIVE a stop, an update, or an eviction.

export const KEYS = {
  runState: 'runState',
  lastStats: 'lastStats',
  lastRoutineDay: 'lastRoutineDay',
  lastScheduledDay: 'lastScheduledDay',
  lastQuery: 'lastQuery',
  pointsHistory: 'pointsHistory',
  lastTabAction: 'lastTabAction',
  lastRewards: 'lastRewards',
  lastStatsLog: 'lastStatsLog',
  lastRedeemLog: 'lastRedeemLog',
  lastImageSearch: 'lastImageSearch',
  lastRedeem: 'lastRedeem',
  lastCoupons: 'lastCoupons',
  lastCouponAction: 'lastCouponAction',
  redeemRestockNews: 'redeemRestockNews',
  redeemSoldOutNews: 'redeemSoldOutNews',
  redeemHistory: 'redeemHistory',
  lastOrders: 'lastOrders',
  lastOrdersLog: 'lastOrdersLog',
  dashLayout: 'dashLayout',
  runHistory: 'runHistory',
  activeRun: 'activeRun',
  postponedRoutine: 'postponedRoutine',
  restockNotifiedAt: 'restockNotifiedAt',
} as const

// ---------- typed storage.local helpers ----------
//
// Thin wrappers so a caller writes `await getLocal<Stats>(KEYS.lastStats)`
// instead of destructuring the get() result and casting every time.

export async function getLocal<T = unknown>(key: string): Promise<T | undefined> {
  const obj = await chrome.storage.local.get(key)
  return obj[key] as T | undefined
}

export async function setLocal(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value })
}

export async function removeLocal(key: string): Promise<void> {
  await chrome.storage.local.remove(key)
}
