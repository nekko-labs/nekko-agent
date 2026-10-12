import { Component, type ErrorInfo, type ReactNode } from 'react';

/** A failed surface must leave navigation and neighbouring sections usable. */
export class ErrorBoundary extends Component<{ children: ReactNode; label: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Could not render ${this.props.label}`, error, info.componentStack);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="mx-auto max-w-xl px-6 py-8" role="alert">
      <p className="text-[14px] font-medium">{this.props.label} could not be displayed</p>
      <p className="mt-2 text-[13px] text-ink-soft">Try opening it again. You can still use the other pages.</p>
      <button className="btn btn-outline mt-4" onClick={() => this.setState({ failed: false })}>Try again</button>
    </div>;
  }
}
