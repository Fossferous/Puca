import { Component, type ErrorInfo, type ReactNode } from 'react';
import { SadFaceIcon } from './Icons';

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

/**
 * Top-level error boundary. A render/runtime error in any child would otherwise
 * blank the whole app to a white screen; this catches it and shows a recoverable
 * fallback with a reload option instead.
 */
export class ErrorBoundary extends Component<Props, State> {
    state: State = { hasError: false, error: null };

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        // Keep a console record for diagnostics; a real deployment can forward
        // this to an error-reporting service here.
        console.error('Uncaught error in React tree:', error, info.componentStack);
    }

    handleReload = () => {
        window.location.reload();
    };

    render() {
        if (!this.state.hasError) return this.props.children;

        return (
            <div
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: '100vh',
                    padding: '2rem',
                    textAlign: 'center',
                    color: 'var(--text-normal, #dcddde)',
                    background: 'var(--bg-primary, #313338)',
                    fontFamily: 'system-ui, sans-serif',
                }}
            >
                <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}><SadFaceIcon size={40} /></div>
                <h1 style={{ fontSize: '1.25rem', margin: '0 0 0.5rem' }}>Something went wrong</h1>
                <p style={{ opacity: 0.75, maxWidth: 420, marginBottom: '1.25rem' }}>
                    The app hit an unexpected error. Reloading usually fixes it. If it keeps
                    happening, your local data may be out of date.
                </p>
                <button
                    onClick={this.handleReload}
                    style={{
                        padding: '0.6rem 1.4rem',
                        borderRadius: 8,
                        border: 'none',
                        background: 'var(--brand, #5865f2)',
                        color: '#fff',
                        fontSize: '0.95rem',
                        cursor: 'pointer',
                    }}
                >
                    Reload
                </button>
                {this.state.error && (
                    <pre
                        style={{
                            marginTop: '1.5rem',
                            maxWidth: '90vw',
                            overflowX: 'auto',
                            fontSize: '0.75rem',
                            opacity: 0.5,
                            textAlign: 'left',
                        }}
                    >
                        {this.state.error.message}
                    </pre>
                )}
            </div>
        );
    }
}
