import type { SVGProps } from 'react'

// Minimal inline icons — one small stroke set, sized by the parent's font/em so
// they inherit color via currentColor. No icon-font dependency.
type IconProps = SVGProps<SVGSVGElement>

function base(props: IconProps) {
  return {
    width: '1em',
    height: '1em',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...props,
  }
}

export const HomeIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V21h14V9.5" />
  </svg>
)

export const PlayIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M7 4.5v15l12-7.5-12-7.5Z" />
  </svg>
)

export const GiftIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 11h16v9H4z" />
    <path d="M3 7h18v4H3zM12 7v13M12 7S10 3 7.5 4 9.5 7 12 7ZM12 7s2-4 4.5-3-.5 3-4.5 3Z" />
  </svg>
)

export const ActivityIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 12h4l3 8 4-16 3 8h4" />
  </svg>
)

export const RewardsIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8 3h8v6a4 4 0 0 1-8 0V3ZM8 5H5v3a3 3 0 0 0 3 3m8-6h3v3a3 3 0 0 1-3 3M12 13v7M8 21h8" />
  </svg>
)

export const RefreshIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M20 11a8 8 0 1 0-.9 4" />
    <path d="M20 4v7h-7" />
  </svg>
)

export const GearIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2.1 2.1M16.9 16.9 19 19M19 5l-2.1 2.1M7.1 16.9 5 19" />
  </svg>
)

export const CloseIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
)

export const BackIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
)

export const StopIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
)

// The three Developer Option buttons (gated on the Settings toggle): opening
// the routine-done page, clearing the once-per-day mark, and probing the
// Rewards API the dashboard loads.
export const CheckCircleIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

export const RedoIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
)

export const FlaskIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M9 3h6M10 3v6l-5.4 9.2A2 2 0 0 0 6.3 21h11.4a2 2 0 0 0 1.7-2.8L14 9V3" />
    <path d="M7.5 15h9" />
  </svg>
)

// The Restart control (6.9.8): a clockwise circular arrow, deliberately the
// mirror of RedoIcon above so the two never read as the same button — a
// restart reloads the whole extension, a redo clears one day's done-mark.
export const RestartIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
)

// The full-screen dashboard opener (always in the topbar): a dashboard panel
// glyph — four unequal panes.
export const LayoutDashboardIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="3" width="8" height="10" rx="1.5" />
    <rect x="13" y="3" width="8" height="6" rx="1.5" />
    <rect x="3" y="15" width="8" height="6" rx="1.5" />
    <rect x="13" y="11" width="8" height="10" rx="1.5" />
  </svg>
)

export const WidgetEditIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <path d="m14 18 6-6 2 2-6 6-3 1 1-3Z" />
  </svg>
)

// The Developer Option banner preview: a bell, for "what the extension can
// raise at the top".
export const BellIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M18 9a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7" />
    <path d="M10.3 20a2 2 0 0 0 3.4 0" />
  </svg>
)
