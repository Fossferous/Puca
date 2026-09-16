import { Component, type ErrorInfo, type ReactNode } from 'react';
import { SadFaceIcon } from './Icons';

interface Props {
    /** Remount key: when the message text changes, re-arm and try again. */
    resetKey: string;
    children: ReactNode;
}

interface State {
    hasError: boolean;
    /** The resetKey the current error belongs to, so a NEW message re-arms. */
    erroredFor: string | null;
}

/**
 * Per-message boundary around the rendered CONTENT of one message.
 *
 * Message bodies are attacker-authored: the sender picks the markdown, and the
 * body is end-to-end encrypted, so no server-side filter can inspect it. That
 * text is fed to several parsers during render (`parseEncAttachment`,
 * `decodeClipRef`, the markdown parser). Before this existed the app's ONLY
 * boundary was the root one (main.tsx), so one throw in one message replaced
 * the whole app with the crash screen — and because Chat auto-selects the first
 * server and its first text channel on every load, that was a permanent crash
 * loop rather than a one-off (0.9.810 audit, C-06).
 *
 * It wraps the CONTENT, deliberately not the whole row: the row's hover
 * toolbar and context menu keep rendering, so a moderator can still delete the
 * offending message — the recovery path that was missing.
 */
export class MessageErrorBoundary extends Component<Props, State> {
    state: State = { hasError: false, erroredFor: null };

    static getDerivedStateFromError(): Partial<State> {
        return { hasError: true };
    }

    static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
        // Re-arm when the message text changes (an edit, or this row being
        // recycled for a different message). Without this the placeholder
        // latches for the lifetime of the component and an edited-to-valid
        // message would never render again.
        if (state.hasError && state.erroredFor !== null && state.erroredFor !== props.resetKey) {
            return { hasError: false, erroredFor: null };
        }
        if (state.hasError && state.erroredFor === null) {
            return { erroredFor: props.resetKey };
        }
        return null;
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        // Keep this loud in the console: the visible failure is now a quiet
        // placeholder, so this is the only signal a NEW render bug leaves.
        console.error('Message failed to render:', error, info.componentStack);
    }

    render() {
        if (!this.state.hasError) return this.props.children;
        return (
            <span className="message-render-failed" title="This message could not be displayed on this device.">
                <SadFaceIcon size={14} />
                {' '}This message could not be displayed.
            </span>
        );
    }
}
