import React from "react";

interface State {
  hasError: boolean;
  error: Error | null;
}

interface Props {
  children: React.ReactNode;
}

/**
 * Top-level error boundary. Catches any uncaught render exception in the app
 * tree and shows a recovery card with reload and "try to continue" actions
 * instead of leaving the user staring at a blank screen.
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] App crashed:", error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleDismiss = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const message = this.state.error?.message ?? "Unknown error";
    const stack = this.state.error?.stack ?? "";

    return (
      <div className="error-boundary-overlay" role="alert" aria-live="assertive">
        <div className="error-boundary-card">
          <h2 className="error-boundary-title">Something went wrong</h2>
          <p className="error-boundary-message">
            The app hit an unexpected error. Reloading usually fixes it. If it keeps happening, share the details below.
          </p>
          <pre className="error-boundary-details">
            <code>{message}</code>
            {stack && <code className="error-boundary-stack">{stack}</code>}
          </pre>
          <div className="error-boundary-actions">
            <button type="button" className="confirm-btn confirm-btn--cancel" onClick={this.handleDismiss}>
              Try to continue
            </button>
            <button type="button" className="confirm-btn confirm-btn--primary" onClick={this.handleReload}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
