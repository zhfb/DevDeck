import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level error boundary — a crash in any panel/tab must never blank the
 * whole app (React unmounts the root on uncaught render/effect errors).
 * Shows an inline recovery card instead.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-background p-8 text-center">
          <div className="text-[15px] font-semibold text-danger">界面遇到错误</div>
          <div className="max-w-[420px] select-text-all font-mono text-[12px] leading-relaxed text-muted">
            {this.state.error.message || String(this.state.error)}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-2 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:bg-accent-hover"
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
