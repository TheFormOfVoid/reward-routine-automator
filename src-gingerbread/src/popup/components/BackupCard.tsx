import { useRef, useState } from 'react'
import { BACKUP_LIMIT_BYTES, downloadBackup, parseBackup, readBackup, restoreBackup, RESTORE_BACKUP_KEY } from '../../shared/backup.ts'
import type { BackupDocument } from '../../shared/backup.ts'
import { useStorageValue } from '../hooks/useStorageValue.ts'
import { Card } from './Card.tsx'

const LABELS: Record<string, string> = { pointsHistory: 'Points history', redeemHistory: 'Stock history', recentQueries: 'Recent queries', dashLayout: 'Dashboard layout', popupWidgetLayout: 'Today widgets', dashHiddenWidgets: 'Dashboard widget visibility', runHistory: 'Run history', lastOrders: 'Orders and redemption codes' }

export function BackupCard() {
  const input = useRef<HTMLInputElement>(null)
  const [includeOrders, setIncludeOrders] = useState(false)
  const [restoreOrders, setRestoreOrders] = useState(false)
  const [replace, setReplace] = useState(false)
  const [preview, setPreview] = useState<BackupDocument | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const { value: recovery } = useStorageValue<BackupDocument | null>('local', RESTORE_BACKUP_KEY, null)
  const perform = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : 'The operation could not finish.') }
    finally { setBusy(false) }
  }
  const choose = async (file: File | undefined) => {
    if (!file) return
    setPreview(null)
    setRestoreOrders(false)
    await perform(async () => {
      if (file.size > BACKUP_LIMIT_BYTES) throw new Error('Choose a backup smaller than 2 MB.')
      setPreview(parseBackup(await file.text()))
    })
  }
  return (
    <Card title="Backup and restore" className="backup-card">
      <div data-no-escape>
        <p className="set-hint">Save your settings, goals, histories and dashboard layout to a file.</p>
        <label className="backup-check"><input type="checkbox" checked={includeOrders} onChange={(event) => setIncludeOrders(event.target.checked)} disabled={busy} /> Include orders and redemption codes in export</label>
        <div className="backup-actions">
          <button className="btn" disabled={busy} onClick={() => perform(async () => { downloadBackup(await readBackup(includeOrders)); setMessage('Backup downloaded.') })}>Export backup</button>
          <button className="btn" disabled={busy} onClick={() => input.current?.click()}>Choose backup</button>
          <input ref={input} type="file" accept=".json,application/json" aria-label="Choose Gingerbread backup" className="backup-file" onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = '' }} />
        </div>
        {preview && <div className="backup-preview">
          <h3>Review restore</h3>
          <p className="set-hint">Gingerbread {preview.extensionVersion} · {new Date(preview.createdAt).toLocaleString()}</p>
          <ul>
            <li>{Object.keys(preview.settings).length} saved preferences</li>
            {Object.entries(preview.data).map(([key, value]) => <li key={key}>{LABELS[key]}{Array.isArray(value) ? ` · ${value.length} entries` : ''}</li>)}
          </ul>
          <fieldset className="backup-mode" disabled={busy}>
            <legend>How to restore</legend>
            <label><input type="radio" name="restore-mode" checked={!replace} onChange={() => setReplace(false)} /> Merge histories; keep existing matching days and orders</label>
            <label><input type="radio" name="restore-mode" checked={replace} onChange={() => setReplace(true)} /> Replace the sections in this backup</label>
          </fieldset>
          {'lastOrders' in preview.data && <label className="backup-check"><input type="checkbox" checked={restoreOrders} onChange={(event) => setRestoreOrders(event.target.checked)} disabled={busy} /> Restore the included orders and redemption codes</label>}
          <p className="set-hint">A recovery backup is saved before changes. Stop current activity before restoring.</p>
          <div className="backup-actions">
            <button className="btn btn--primary" disabled={busy} onClick={() => perform(async () => { await restoreBackup(preview, replace, restoreOrders); setPreview(null); setMessage('Backup restored. Your previous data is available as a recovery backup.') })}>{busy ? 'Restoring…' : 'Restore reviewed backup'}</button>
            <button className="btn" disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
          </div>
        </div>}
        {recovery && <button className="btn backup-recovery" disabled={busy} onClick={() => perform(async () => { const document = parseBackup(JSON.stringify(recovery)); if (!includeOrders) delete document.data.lastOrders; downloadBackup(document, 'Gingerbread recovery'); setMessage('Recovery backup downloaded.') })}>Download previous data</button>}
        <p className="set-hint backup-diagnostics-note">Diagnostics include versions, task outcomes and timings. Queries, page contents, account balances and order codes are excluded.</p>
        <button className="btn" disabled={busy} onClick={() => perform(async () => { const { downloadDiagnostics } = await import('../../shared/diagnostics.ts'); await downloadDiagnostics(); setMessage('Diagnostics downloaded.') })}>Export diagnostics</button>
        {message && <p className="backup-message" role="status">{message}</p>}
        {error && <p className="backup-error" role="alert">{error}</p>}
      </div>
    </Card>
  )
}
