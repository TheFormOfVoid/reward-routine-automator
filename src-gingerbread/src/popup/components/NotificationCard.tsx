import { useState } from 'react'
import type { ReactNode } from 'react'
import { useStorageValue } from '../hooks/useStorageValue.ts'
import { CloseIcon } from './icons.tsx'

type NoticeKind = 'bingApp' | 'restock' | 'soldOut' | 'update'

export function NotificationCard({ children, onDismiss, dismissLabel, tone = 'warn', className = '', title, urgent = false }: {
  children: ReactNode
  onDismiss: () => void
  dismissLabel: string
  tone?: 'danger' | 'good' | 'warn' | 'update'
  className?: string
  title?: string
  urgent?: boolean
}) {
  return <div className={`notice notice--${tone} ${className}`} role={urgent ? 'alert' : 'status'} title={title} data-no-escape>
    <div className="notice-body">{children}</div>
    <button className="notice-dismiss" type="button" onClick={onDismiss} aria-label={dismissLabel} title="Dismiss">
      <CloseIcon aria-hidden="true" />
    </button>
  </div>
}

/** Four bounded acknowledgement slots; dismissing never edits the underlying read. */
export function DismissibleNotice({ kind, fingerprint, preview = false, ...props }: Omit<Parameters<typeof NotificationCard>[0], 'onDismiss'> & {
  kind: NoticeKind
  fingerprint: string
  preview?: boolean
}) {
  const key = `dismissedNotice:${kind}`
  const stored = useStorageValue<string | null>('local', key, null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const identity = `${preview ? 'preview' : 'live'}:${fingerprint}`
  if ((!preview && !stored.loaded && !stored.error) || dismissed === identity || (!preview && stored.value === fingerprint)) return null
  function dismiss() {
    setDismissed(identity)
    if (!preview) void chrome.storage.local.set({ [key]: fingerprint }).catch(error => console.warn('Could not remember notification dismissal:', error))
  }
  return <NotificationCard {...props} onDismiss={dismiss} />
}
