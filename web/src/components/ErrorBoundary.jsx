// Catches render errors so that one failing card shows its error instead of unmounting the whole app (black screen).
import { Component } from 'react';

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ui] render error', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error" role="alert">
        <b>{this.props.label ?? 'This part of the screen'} failed to render.</b>{' '}
        <span className="mono">{String(error?.name ?? 'Error')}: {String(error?.message ?? error)}</span>
        <div className="muted" style={{ marginTop: 4 }}>Please send this message (it contains no data). The rest of the app keeps working.</div>
        {this.props.onReset && (
          <button className="btn" style={{ marginTop: 6 }} onClick={() => { this.setState({ error: null }); this.props.onReset(); }}>Dismiss</button>
        )}
      </div>
    );
  }
}
