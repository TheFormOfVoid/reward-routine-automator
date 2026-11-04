import brandMarkUrl from '../../../icons/icon.svg?url'

// Share the editable source used to render the toolbar PNGs, so app branding
// cannot drift into a second, independently drawn icon.
export function BrandMark({ size = 22, className }: { size?: number; className?: string }) {
  return <img src={brandMarkUrl} width={size} height={size} className={className} alt="" aria-hidden="true" draggable={false} />
}
