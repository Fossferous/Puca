/**
 * The push channel for the in-app message shade, separate from the component
 * file so WS handlers can import it without dragging a component export into
 * a non-component module (react-refresh requires component files to export
 * only components).
 */

export interface MessageToastInput {
    title: string;
    body?: string;
    onClick?: () => void;
}

let sink: ((t: MessageToastInput) => void) | null = null;

/** Fire-and-forget from WS handlers. No-op while no <MessageToasts/> is
 *  mounted (login screen, logout). */
export function pushMessageToast(t: MessageToastInput): void {
    sink?.(t);
}

/** Wired by <MessageToasts/> on mount; cleared on unmount. */
export function setMessageToastSink(fn: ((t: MessageToastInput) => void) | null): void {
    sink = fn;
}
