import { Component } from 'react'
import type { ReactNode } from 'react'

export class ViewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <div className="view-loading" role="alert"><p>This view could not open.</p><button className="btn" onClick={() => location.reload()}>Reload view</button></div>
    return this.props.children
  }
}
