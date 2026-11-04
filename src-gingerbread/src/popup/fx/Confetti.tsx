import { useEffect } from 'react'

// One celebratory burst on mount — the finish screen's flourish (the routine's
// end overlay on the dashboard). Two side cannons firing inward for ~700ms. A
// no-op when motion is off, so the screen is identical minus the celebration
// under reduced motion.
export function Confetti({ fire }: { fire: boolean }) {
  useEffect(() => {
    if (!fire) return
    let active = true
    let raf = 0
    let clear: (() => void) | undefined
    const colors = ['#06b6d4', '#22d3ee', '#a5f3fc', '#ffffff']
    void import('canvas-confetti').then(({ default: confetti }) => {
      if (!active) return
      const end = Date.now() + 700
      const cannon = confetti.create(undefined, { resize: true })
      clear = () => cannon.reset()
      const frame = (): void => {
      if (!active) return
      cannon({ particleCount: 4, angle: 60, spread: 60, startVelocity: 45, origin: { x: 0, y: 0.7 }, colors })
      cannon({ particleCount: 4, angle: 120, spread: 60, startVelocity: 45, origin: { x: 1, y: 0.7 }, colors })
      if (Date.now() < end) raf = requestAnimationFrame(frame)
      }
      frame()
    }).catch(() => {})
    return () => {
      active = false
      cancelAnimationFrame(raf)
      clear?.()
    }
  }, [fire])

  return null
}
