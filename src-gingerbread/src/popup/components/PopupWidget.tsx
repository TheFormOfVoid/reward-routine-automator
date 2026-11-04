import type { ReactNode } from 'react'
import type { PopupWidget as Widget, WidgetSize } from '../lib/widget-layout.ts'
import { WIDGETS } from '../lib/widget-layout.ts'
import { Card } from './Card.tsx'
import { CloseIcon } from './icons.tsx'

export function PopupWidget({ widget, editing, first, last, resize, move, remove, children }: {
  widget: Widget; editing: boolean; first: boolean; last: boolean
  resize: (size: WidgetSize) => void; move: (direction: -1 | 1) => void; remove: () => void; children: ReactNode
}) {
  const title = WIDGETS.find(item => item.id === widget.id)!.title
  return <div className={`popup-widget popup-widget--${widget.size}${editing ? ' popup-widget--editing' : ''}`} data-widget-id={widget.id}>
    <Card title={title} className={`widget-${widget.id}`} action={editing && <button type="button" className="icon-btn widget-remove" onClick={remove} aria-label={`Remove ${title}`} title={`Remove ${title}`}><CloseIcon aria-hidden="true" /></button>}>
      {editing && <div className="widget-controls" data-no-escape>
        <label><span className="visually-hidden">Size of {title}</span><select aria-label={`Size of ${title}`} value={widget.size} onChange={event => resize(event.target.value as WidgetSize)}>
          <option value="compact">Compact</option><option value="wide">Wide</option><option value="detailed">Detailed</option>
        </select></label>
        <div><button type="button" className="icon-btn" disabled={first} aria-label={`Move ${title} earlier`} onClick={() => move(-1)}>↑</button>
          <button type="button" className="icon-btn" disabled={last} aria-label={`Move ${title} later`} onClick={() => move(1)}>↓</button></div>
      </div>}
      {children}
    </Card>
  </div>
}
