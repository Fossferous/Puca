/**
 * The plugin's core, outside React: it owns the hidden Púca view, talks to the
 * backend (main.py), answers the page's microphone requests, turns a back
 * button (which the backend reads) into push-to-talk and Púca's notifications
 * into Steam toasts. The Quick Access panel and the full view only read its
 * snapshot and call it.
 */
import { addEventListener, call, removeEventListener, toaster } from '@decky/api';
import { Navigation } from '@decky/ui';
import { createElement } from 'react';
import { PucaBrowserView } from './browserView';
import { PucaIcon } from './components/icons';
import { MicBridge, type MicAnswer } from './micBridge';
import { HoldFollower } from './ptt';
import { readPageMessage, readState, readVoiceChannels, type EmbedState, type EmbedVoiceChannel, type PageNotification } from './protocol';
import { DEFAULT_SETTINGS, normalizeAppUrl, readSettings, type PluginSettings, type PushToTalkButton } from './settings';

export const FULL_VIEW_ROUTE = '/puca';

export type Phase =
    /** Reading settings. */
    | 'starting'
    /** No Púca address yet. */
    | 'no-address'
    /** Not in Game Mode: browser views exist only there. */
    | 'no-game-mode'
    /** The page is loading. */
    | 'loading'
    /** Púca is running in the view. */
    | 'ready'
    /** The server's Púca predates the embedding API (docs/EMBEDDING.md). */
    | 'unsupported'
    /** Something failed: `error` says what. */
    | 'error';

export interface Snapshot {
    phase: Phase;
    error: string | null;
    settings: PluginSettings;
    /** Púca's own state, as the page last reported it. */
    state: EmbedState | null;
    /** The Deck's microphone is open for Púca. */
    micOn: boolean;
    /** The push-to-talk button is held. */
    talking: boolean;
    /** Why push-to-talk cannot read the controller ("no-controller",
     *  "no-access", or the backend's error), while it is trying to. */
    pttError: string | null;
    viewOpen: boolean;
}

type CallResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** After a failure, try again this long after, doubling to RETRY_MAX_MS:
 *  a Deck often wakes before its Wi-Fi does, and Púca must come back by
 *  itself once it can. Reset when Púca is up. */
const RETRY_MS = 5000;
const RETRY_MAX_MS = 60000;
/** A page that has not said it is Púca by then (an error page, a captive
 *  portal, a server that is down) is reported, not waited on forever. */
const LOAD_TIMEOUT_MS = 30000;

const randomId = (): string => {
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
};

class Controller {
    private snap: Snapshot = {
        phase: 'starting', error: null, settings: DEFAULT_SETTINGS, state: null,
        micOn: false, talking: false, pttError: null, viewOpen: false,
    };
    private listeners = new Set<() => void>();
    private view = new PucaBrowserView();
    private bridge = new MicBridge(
        (id, reply) => this.answerMic(id, reply),
        count => this.update({ micOn: count > 0 }),
        line => console.log(`[Púca] ${line}`),
    );
    // Push-to-talk: Púca's hold follows the backend's "puca_button" signal.
    private hold = new HoldFollower({
        down: () => { this.update({ talking: true }); void this.pageCall('holdPushToTalk', [true]); },
        renew: () => { void this.pageCall('holdPushToTalk', [true]); },
        up: () => { this.update({ talking: false }); void this.pageCall('holdPushToTalk', [false]); },
    });
    /** The button the backend is following now, if any. */
    private watching: PushToTalkButton | null = null;
    private watchSeq = 0;
    private onButton = (held: unknown) => { if (this.watching) this.hold.signal(held); };
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private loadTimer: ReturnType<typeof setTimeout> | null = null;
    private bootSeq = 0;
    private retries = 0;
    private started = false;
    private onPage = (payload: unknown) => this.handlePage(payload);
    private onStatus = (status: unknown) => this.handleStatus(status);

    // ---- The store React reads ------------------------------------------------

    subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    };

    getSnapshot = (): Snapshot => this.snap;

    private update(patch: Partial<Snapshot>): void {
        this.snap = { ...this.snap, ...patch };
        this.listeners.forEach(fn => fn());
        this.syncButtonWatch();
    }

    // ---- Life cycle ------------------------------------------------------------

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;
        addEventListener('puca_page', this.onPage);
        addEventListener('puca_status', this.onStatus);
        addEventListener('puca_button', this.onButton);
        let settings = DEFAULT_SETTINGS;
        try {
            settings = readSettings(await call<[], unknown>('get_settings'));
        } catch (err) {
            console.warn('[Púca] could not read settings:', err);
        }
        this.update({ settings });
        await this.boot();
    }

    stop(): void {
        if (!this.started) return;
        this.started = false;
        this.bootSeq++;
        removeEventListener('puca_page', this.onPage);
        removeEventListener('puca_status', this.onStatus);
        removeEventListener('puca_button', this.onButton);
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        this.clearLoadTimer();
        this.hold.reset();
        if (this.watching) {
            this.watching = null;
            this.watchSeq++;
            void call('unwatch_button').catch(() => {});
        }
        this.bridge.releaseAll();
        this.view.destroy();
        void call('detach').catch(() => {});
    }

    /** (Re)load Púca in a fresh view. */
    private async boot(): Promise<void> {
        const seq = ++this.bootSeq;
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        this.clearLoadTimer();
        this.bridge.releaseAll();
        const url = this.snap.settings.appUrl;
        if (!url) {
            this.view.destroy();
            this.update({ phase: 'no-address', error: null, state: null });
            return;
        }
        const marker = `puca-decky-${randomId()}`;
        if (!this.view.create(marker)) {
            // Steam's main window is not there yet (very early in a boot),
            // or this is not Game Mode: look again shortly.
            this.update({ phase: 'no-game-mode', error: null, state: null });
            this.retryLater();
            return;
        }
        this.update({ phase: 'loading', error: null, state: null });
        this.armLoadTimer();
        let res: CallResult<null>;
        try {
            res = await call<[string, string], CallResult<null>>('attach', marker, url);
        } catch (err) {
            res = { ok: false, error: String((err as Error)?.message ?? err) };
        }
        if (seq !== this.bootSeq) return;
        if (!res.ok) {
            this.update({ phase: 'error', error: `Could not start Púca: ${res.error}` });
            this.retryLater();
        }
    }

    private armLoadTimer(): void {
        this.clearLoadTimer();
        this.loadTimer = setTimeout(() => {
            this.loadTimer = null;
            if (this.snap.phase !== 'loading') return;
            const host = (() => { try { return new URL(this.snap.settings.appUrl).host; } catch { return 'your Púca server'; } })();
            this.update({ phase: 'error', error: `${host} did not open Púca. Check the address and that the Deck is online.` });
            this.retryLater();
        }, LOAD_TIMEOUT_MS);
    }

    private clearLoadTimer(): void {
        if (this.loadTimer) { clearTimeout(this.loadTimer); this.loadTimer = null; }
    }

    private retryLater(): void {
        if (this.retryTimer || !this.started) return;
        const delay = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** this.retries);
        this.retries++;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (this.started) void this.boot();
        }, delay);
    }

    /** Try again now (the panel's button), with the waits starting over. */
    reload(): void {
        this.retries = 0;
        void this.boot();
    }

    // ---- Settings --------------------------------------------------------------

    /** Save the Púca address; reloads the view when it changed. */
    async setAddress(input: string): Promise<string | null> {
        const n = normalizeAppUrl(input);
        if (!n.ok) return n.error;
        await this.saveSettings({ appUrl: n.url });
        return null;
    }

    async saveSettings(patch: Partial<PluginSettings>): Promise<void> {
        const before = this.snap.settings;
        const next = readSettings({ ...before, ...patch });
        try {
            this.update({ settings: readSettings(await call<[PluginSettings], unknown>('set_settings', next)) });
        } catch (err) {
            console.warn('[Púca] could not save settings:', err);
            this.update({ settings: next });
        }
        const now = this.snap.settings;
        if (now.pushToTalk !== before.pushToTalk) {
            // The back button is how the Deck talks: switch Púca's input mode
            // with it, both ways. Púca keeps it per device, like Settings does.
            void this.pageCall('setInputMode', [now.pushToTalk === 'off' ? 'open' : 'pushToTalk']);
        }
        if (now.appUrl !== before.appUrl) await this.boot();
    }

    // ---- Talking to the page ------------------------------------------------------

    private async pageCall<T = unknown>(method: string, args: unknown[] = []): Promise<CallResult<T>> {
        try {
            return await call<[string, unknown[]], CallResult<T>>('page_call', method, args);
        } catch (err) {
            return { ok: false, error: String((err as Error)?.message ?? err) };
        }
    }

    async listVoiceChannels(serverId: string): Promise<EmbedVoiceChannel[]> {
        const r = await this.pageCall('listVoiceChannels', [serverId]);
        return r.ok ? readVoiceChannels(r.value) : [];
    }

    async join(serverId: string, channelId: number): Promise<string | null> {
        // A join starts call audio: let the page play it as after a click.
        this.view.activate();
        const r = await this.pageCall<{ ok: boolean; error?: string }>('joinVoice', [serverId, channelId]);
        if (!r.ok) return r.error;
        return r.value?.ok ? null : (r.value?.error ?? 'could not join');
    }

    leave(): void {
        void this.pageCall('leaveVoice');
    }

    setMuted(muted: boolean): void {
        void this.pageCall('setMuted', [muted]);
    }

    setDeafened(deafened: boolean): void {
        void this.pageCall('setDeafened', [deafened]);
    }

    private async refreshState(): Promise<void> {
        const r = await this.pageCall('getState');
        if (r.ok) {
            const state = readState(r.value);
            if (state) this.update({ state });
        }
    }

    // ---- The full view ---------------------------------------------------------------

    openFullView(): void {
        Navigation.Navigate(FULL_VIEW_ROUTE);
        Navigation.CloseSideMenus();
    }

    showView(rect: { x: number; y: number; width: number; height: number }): void {
        this.view.show(rect);
        this.view.activate();
        if (!this.snap.viewOpen) {
            this.update({ viewOpen: true });
            void call('set_foreground', true).catch(() => {});
        }
    }

    hideView(): void {
        this.view.hide();
        if (this.snap.viewOpen) {
            this.update({ viewOpen: false });
            void call('set_foreground', false).catch(() => {});
        }
    }

    // ---- Events from the backend ---------------------------------------------------

    private handlePage(payload: unknown): void {
        const msg = readPageMessage(payload);
        if (!msg) return;
        switch (msg.type) {
            case 'ready':
                this.clearLoadTimer();
                this.retries = 0;
                if (msg.apiVersion === 1) {
                    if (this.snap.phase !== 'ready') {
                        this.update({ phase: 'ready', error: null });
                        void this.refreshState();
                        if (this.snap.settings.pushToTalk !== 'off') void this.pageCall('setInputMode', ['pushToTalk']);
                    }
                } else {
                    this.update({ phase: 'unsupported', error: null });
                }
                return;
            case 'state':
                this.update({ state: msg.state, ...(this.snap.phase === 'loading' ? { phase: 'ready' as const } : {}) });
                return;
            case 'notify':
                this.showNotification(msg.notification);
                return;
            case 'mic-request':
                void this.bridge.request(msg.id, msg.constraints, msg.offer);
                return;
            case 'mic-release':
                this.bridge.release(msg.id);
                return;
        }
    }

    private handleStatus(status: unknown): void {
        const s = status && typeof status === 'object' ? status as Record<string, unknown> : {};
        switch (s.type) {
            case 'navigated':
                // A new document: whatever the old one held is gone.
                this.bridge.releaseAll();
                if (s.onApp === false) {
                    // A link took the view away from Púca (Púca opens links
                    // in a new window, so this is rare): say so, and Try
                    // again brings it back.
                    this.clearLoadTimer();
                    this.update({ phase: 'error', error: 'The Púca view went to another page.', state: null });
                } else if (this.snap.phase !== 'ready') {
                    this.armLoadTimer();
                }
                return;
            case 'crashed':
            case 'detached':
                this.bridge.releaseAll();
                this.hold.reset();
                if (!this.started) return;
                this.update({ phase: 'error', error: 'Púca stopped. Restarting…', state: null });
                this.retryLater();
                return;
            case 'load-failed':
                this.clearLoadTimer();
                this.update({ phase: 'error', error: `Could not reach ${typeof s.host === 'string' ? s.host : 'your Púca server'}. Check the address and your connection.` });
                this.retryLater();
                return;
        }
    }

    private answerMic(id: string, reply: MicAnswer): Promise<void> {
        return call<[string, MicAnswer['answer'], MicAnswer['error']], void>('mic_answer', id, reply.answer, reply.error);
    }

    private showNotification(n: PageNotification): void {
        if (!this.snap.settings.notifications) return;
        toaster.toast({
            title: n.title,
            body: n.body,
            logo: createElement(PucaIcon, { size: 40 }),
            playSound: this.snap.settings.notificationSound,
            onClick: () => {
                this.openFullView();
                void this.pageCall('activateNotification', [n.id]);
            },
        });
    }

    // ---- Push-to-talk on a back button ------------------------------------------------

    /**
     * The backend reads the controller only while push-to-talk can matter: a
     * button is chosen and Púca is in (or joining) a call. Runs on every
     * snapshot change; does nothing unless the answer changed.
     */
    private syncButtonWatch(): void {
        const choice = this.snap.settings.pushToTalk;
        const want = this.started && choice !== 'off' && this.snap.state?.call ? choice : null;
        if (want === this.watching) return;
        this.watching = want;
        this.hold.reset();
        const seq = ++this.watchSeq;
        if (want === null) {
            void call('unwatch_button').catch(() => {});
            if (this.snap.pttError !== null) this.update({ pttError: null });
            return;
        }
        void call<[string], CallResult<string | null>>('watch_button', want).then(
            r => { if (seq === this.watchSeq) this.update({ pttError: r.ok ? r.value : r.error }); },
            err => { if (seq === this.watchSeq) this.update({ pttError: String((err as Error)?.message ?? err) }); },
        );
    }
}

export const controller = new Controller();
