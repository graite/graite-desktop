import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportError } from "@/lib/clientLog";

/** Keeps one failing part of the UI from blanking the whole window. Without it, an error
 * thrown while rendering unmounts the app and leaves an empty page. */
export class ErrorBoundary extends Component<
  { children: ReactNode; area: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error.message, error, `${this.props.area}${info.componentStack ?? ""}`);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-boundary" role="alert">
        <p>Something went wrong in {this.props.area}.</p>
        <p className="error-boundary-detail">{this.state.error.message}</p>
        <div className="error-boundary-actions">
          <button type="button" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button type="button" onClick={() => window.location.reload()}>
            Reload Graite
          </button>
        </div>
      </div>
    );
  }
}
