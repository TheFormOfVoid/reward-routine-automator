import { useLayoutEffect } from 'react'
import type { Settings } from '../../shared/settings.ts'
import { inkFor } from '../lib/format.ts'

const HEX = /^#?[0-9a-f]{6}$/i

// Paint the theme axes onto <html>: data-appearance drives the neutral ramp
// (auto resolved here to the OS preference), data-theme the accent hue, and a
// non-empty accentColor overrides --accent inline with a matching ink. The
// backdrop knobs ride along: --bg-brightness (the .bg layer's brightness
// filter) and --tile-blur (the cards' glass blur), both read with fallbacks in
// the CSS so an unset variable is just the default look. Kept in one effect so
// the <html> attributes and inline vars never disagree.
export function useTheme(
  settings: Pick<Settings, 'appearance' | 'theme' | 'accentColor' | 'backgroundBrightness' | 'tileBlur'>,
): void {
  const { appearance, theme, accentColor, backgroundBrightness, tileBlur } = settings

  useLayoutEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia('(prefers-color-scheme: dark)')

    const apply = (): void => {
      root.dataset.appearance = appearance === 'auto' ? (media.matches ? 'dark' : 'light') : appearance
      root.dataset.theme = theme

      const raw = (accentColor || '').trim()
      if (HEX.test(raw)) {
        const hex = raw.startsWith('#') ? raw : `#${raw}`
        root.style.setProperty('--accent', hex)
        root.style.setProperty('--accent-2', hex)
        root.style.setProperty('--accent-ink', inkFor(hex))
      } else {
        root.style.removeProperty('--accent')
        root.style.removeProperty('--accent-2')
        root.style.removeProperty('--accent-ink')
      }

      root.style.setProperty('--bg-brightness', String((backgroundBrightness || 100) / 100))
      root.style.setProperty('--tile-blur', `${tileBlur ?? 10}px`)
      // 0 blur = a fully transparent tile. Above 0, the surface tint ramps
      // WITH the blur: a 90%-opaque tint hides the very blur this knob dials
      // (the "I don't see a difference" report), so a light blur is also a
      // clear, barely-tinted tile, and only a heavily frosted one approaches
      // the old solid look.
      const blur = Math.max(0, Number(tileBlur ?? 10))
      if (blur <= 0) {
        root.style.setProperty('--tile-tint', 'transparent')
      } else {
        const alpha = Math.min(75, Math.round(15 + (blur / 30) * 60))
        root.style.setProperty('--tile-tint', `color-mix(in srgb, var(--surface) ${alpha}%, transparent)`)
      }
    }

    apply()
    // Re-resolve "auto" if the OS flips light/dark while the popup is open.
    if (appearance === 'auto') {
      media.addEventListener('change', apply)
      return () => media.removeEventListener('change', apply)
    }
  }, [appearance, theme, accentColor, backgroundBrightness, tileBlur])
}
