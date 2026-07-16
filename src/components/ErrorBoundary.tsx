import { Component, type ErrorInfo, type ReactNode } from "react";

// Minimal React error boundary. React only supports this via a class
// component (no hook equivalent for componentDidCatch/getDerivedStateFromError
// as of React 18) - wraps the main content pane so a malformed data payload
// (a bad job frontmatter field, an unexpected shape from the file bridge)
// renders a friendly "could not render this view" message in that pane
// instead of white-screening the whole app (TopBar, nav, etc. stay usable).
interface Props {
  children: ReactNode;
  // Optional compact fallback for chrome surfaces (the TopBar strip, the
  // ChatCapture FAB - t-1783145481687) where the default full-pane message
  // would be oversized. Pass null to render nothing on a crash (the surface
  // simply disappears; the error is still logged by componentDidCatch).
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("ErrorBoundary caught a render error:", error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      // A caller-supplied fallback (including an explicit null) wins over the
      // default full-pane message.
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="text-[15px] font-semibold text-[var(--color-text)]">Could not render this view</div>
          <p className="max-w-md text-[13px] text-[var(--color-muted)]">
            Something in the data for this screen was not in the shape the UI expected. The rest of the app is
            still usable - try another view, or reload.
          </p>
          <p className="max-w-md truncate font-mono text-[11px] text-[#7c88a4]" title={this.state.error.message}>
            {this.state.error.message}
          </p>
          <button
            type="button"
            onClick={this.reset}
            className="mt-1 inline-flex min-h-[36px] items-center rounded-md border border-[var(--color-edge)] bg-[var(--color-panel-2)] px-3 text-[13px] font-medium text-[var(--color-text)] hover:border-[var(--color-accent)]"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
