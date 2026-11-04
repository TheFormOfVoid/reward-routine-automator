export function StorageGate({ error, retry }: { error: string | null; retry: () => void }) {
  return (
    <div className="storage-gate" role={error ? 'alert' : 'status'} aria-busy={!error}>
      <h1>{error ? 'Settings unavailable' : 'Opening Gingerbread…'}</h1>
      <p>{error || 'Reading your saved preferences.'}</p>
      {error && <button className="btn" onClick={retry}>Try again</button>}
    </div>
  )
}
