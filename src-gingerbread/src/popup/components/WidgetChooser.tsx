import { useId, useRef } from 'react'
import { createPortal } from 'react-dom'

export function WidgetChooser({ name, items, onToggle, disabled = false }: {
  name: string
  items: { id: string; title: string; visible: boolean }[]
  onToggle: (id: string, visible: boolean) => void
  disabled?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const heading = useId()
  return <>
    <button className="btn btn--sm widget-add" type="button" disabled={disabled} onClick={() => ref.current?.showModal()}>Add widgets</button>
    {createPortal(<dialog className="widget-dialog" ref={ref} aria-labelledby={heading}>
      <header className="widget-dialog-head"><div><h2 id={heading}>{name}</h2><p>Choose what appears on your board.</p></div>
        <button className="btn btn--sm" type="button" autoFocus onClick={() => ref.current?.close()}>Close</button></header>
      <div className="widget-options">{items.map(item => <label key={item.id}>
        <span>{item.title}</span><input type="checkbox" checked={item.visible} onChange={event => onToggle(item.id, event.target.checked)} />
      </label>)}</div>
    </dialog>, document.body)}
  </>
}
