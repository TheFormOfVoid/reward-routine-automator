import { RewardsIcon } from './icons.tsx'

export function RewardsLink({ label = false, className = '' }: { label?: boolean; className?: string }) {
  return <a className={`${label ? 'btn' : 'icon-btn'} rewards-link ${className}`}
    href="https://rewards.bing.com/dashboard" target="_blank" rel="noopener noreferrer"
    aria-label="Open Bing Rewards" title="Open Bing Rewards in a new tab" data-no-escape>
    <RewardsIcon aria-hidden="true" />
    {label && <span>Bing Rewards</span>}
  </a>
}
