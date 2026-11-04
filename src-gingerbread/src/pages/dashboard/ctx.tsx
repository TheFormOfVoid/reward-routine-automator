// The dashboard's two small contexts (6.8.0 rewrite) — kept in one
// framework-free module so every tile can import them without cycles:
//
// - DashboardCtx: the page-level wiring a tile can't own (the settings
//   surface's save, the run controls' send/busy, the animations flag). The
//   page provides it; tiles consume slices.
// - GridCtx: the board's edit mode (whether grips and drag affordances
//   show). The GridLayout wrapper provides it.

import { createContext, useContext } from 'react'
import type { Message, MessageResponse } from '../../shared/messages.ts'
import type { Settings } from '../../shared/settings.ts'
import type { RunState } from '../../shared/storage.ts'

export interface DashboardWiring {
  settings: Settings
  save: (patch: Partial<Settings>) => Promise<Settings>
  runState: RunState
  send: (message: Message) => Promise<MessageResponse>
  busy: Message['type'] | null
  animate: boolean
}

export const DashboardCtx = createContext<DashboardWiring | null>(null)

export function useDash(): DashboardWiring {
  const ctx = useContext(DashboardCtx)
  if (!ctx) throw new Error('useDash: the tile sits outside DashboardCtx')
  return ctx
}

export interface GridMode {
  editing: boolean
  hide?: (id: string) => void
  resize?: (id: string, w: number, h: number) => void
}

export const GridCtx = createContext<GridMode>({ editing: false })
