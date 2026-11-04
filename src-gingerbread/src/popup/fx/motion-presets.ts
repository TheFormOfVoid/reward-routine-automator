import type { Transition, Variants } from 'framer-motion'
import { useSyncExternalStore } from 'react'

const subscribeVisibility = (notify: () => void) => {
  document.addEventListener('visibilitychange', notify)
  return () => document.removeEventListener('visibilitychange', notify)
}
const pageVisible = () => document.visibilityState !== 'hidden'
let reducedMedia: MediaQueryList | null = null
const reductionMedia = () => reducedMedia ||= window.matchMedia('(prefers-reduced-motion: reduce)')
const prefersReduction = () => reductionMedia().matches
const subscribeReduction = (notify: () => void) => {
  const media = reductionMedia()
  media.addEventListener('change', notify)
  return () => media.removeEventListener('change', notify)
}

// Motion is gated on BOTH the user's animationsEnabled setting AND the OS
// reduced-motion preference — either one off means no motion. Components take
// the resulting boolean and pass `initial` values that already sit at their
// resting state, so the reduced path renders the final frame with no animation.
export function useMotionEnabled(animationsEnabled: boolean): boolean {
  const reduce = useSyncExternalStore(subscribeReduction, prefersReduction)
  const visible = useSyncExternalStore(subscribeVisibility, pageVisible)
  return animationsEnabled && !reduce && visible
}

export const spring: Transition = { type: 'spring', stiffness: 440, damping: 34 }
export const softSpring: Transition = { type: 'spring', stiffness: 260, damping: 30 }

// View swap: a gentle rise + fade. The distance is small so it reads as the
// content settling into place, not sliding across.
export const viewVariants: Variants = {
  initial: { opacity: 0, y: 10 },
  enter: {
    opacity: 1,
    y: 0,
    transition: { ...softSpring, staggerChildren: 0.05, delayChildren: 0.03 },
  },
  exit: { opacity: 0, y: -8, transition: { duration: 0.12 } },
}

// Card entrance, staggered by the parent view's `enter` (variant propagation —
// a child with these variants animates to the parent's current label on its own).
export const cardVariants: Variants = {
  initial: { opacity: 0, y: 12 },
  enter: { opacity: 1, y: 0, transition: softSpring },
  exit: { opacity: 0 },
}
