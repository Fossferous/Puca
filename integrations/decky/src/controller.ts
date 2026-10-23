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
import { SilentNotice } from './micSilence';
import { HoldFollower, PressFollower } from './ptt';
import {
    liveChannels, readPageMessage, readState, readVoiceChannels,
    type EmbedState, type EmbedVoiceChannel, type LiveChannel, type PageNotification,
} from './protocol';
import {
    assignButton, DEFAULT_SETTINGS, jobOf, normalizeAppUrl, PUSH_TO_TALK_BUTTONS, readSettings, watchedButtons,
    type ButtonJob, type PluginSettings, type PushToTalkButton,
} from './settings';
import { isNewer, readKey, readOffer, verifyOffer, type UpdateKey, type UpdateOffer } from './update';

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
    /** It is delivering only digital silence: muted, or turned all the way
     *  down in Steam's Settings → Audio (micSilence.ts). */
    micSilent: boolean;
    /** The push-to-talk button is held. */
    talking: boolean;
    /** The plugin switched the Deck's muted microphone on for this call, and
     *  mutes it again when the call ends (settings.micForCalls). */
    micSwitchedOn: boolean;
    /** Why the Deck's controls cannot be read ("no-controller", "no-access",
     *  or the backend's error), while a call is trying to. */
    pttError: string | null;
    viewOpen: boolean;
    /** This plugin's version, as Decky runs it. */
    pluginVersion: string | null;
    /** A newer plugin that the download site offers, signed with the release
     *  key (update.ts); null when there is none. */
    update: UpdateState | null;
}

export interface UpdateState {
    version: string;
    /** Downloading it, or handing it to Decky. */
    busy: boolean;
    /** Why the last try did not work. */
    error: string | null;
}

/** What learnButton found: the back button pressed (and the job it was taken
 *  from, if another had it), none in time, or why the controller cannot be
 *  read. */
export type LearnResult =
    | { button: Exclude<PushToTalkButton, 'off'>; took: ButtonJob | null }
    | { button: null }
    | { error: string };

type CallResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** After a failure, try again this long after, doubling to RETRY_MAX_MS:
 *  a Deck often wakes before its Wi-Fi does, and Púca must come back by
 *  itself once it can. Reset when Púca is up. */
const RETRY_MS = 5000;
const RETRY_MAX_MS = 60000;
/** A page that has not said it is Púca by then (an error page, a captive
 *  portal, a server that is down) is reported, not waited on forever. */
const LOAD_TIMEOUT_MS = 30000;
/** A join that finds Púca still starting (a reload) waits this long for it. */
const JOIN_WAIT_MS = 8000;
/** How long Settings waits for a back button to be pressed. */
const LEARN_TIMEOUT_S = 15;
/** "Live now" looks at this many of the person's servers at most. */
const LIVE_SERVERS_MAX = 25;
/** The first look for a plugin update once Púca is up, then how often. */
const UPDATE_FIRST_CHECK_MS = 20 * 1000;
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;

const randomId = (): string => {
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
};

class Controller {
    private snap: Snapshot = {
        phase: 'starting', error: null, settings: DEFAULT_SETTINGS, state: null,
        micOn: false, micSilent: false, talking: false, micSwitchedOn: false, pttError: null, viewOpen: false,
        pluginVersion: null, update: null,
    };
    private listeners = new Set<() => void>();
    private view = new PucaBrowserView();
    private bridge = new MicBridge(
        (id, reply) => this.answerMic(id, reply),
        count => this.update({ micOn: count > 0 }),
        line => console.log(`[Púca] ${line}`),
        undefined,
        silent => this.update({ micSilent: silent }),
    );
    private silentNotice = new SilentNotice();
    // Push-to-talk: Púca's hold follows the backend's "puca_button" signal.
    private hold = new HoldFollower({
        down: () => { this.update({ talking: true }); void this.pageCall('holdPushToTalk', [true]); },
        renew: () => { void this.pageCall('holdPushToTalk', [true]); },
        up: () => { this.update({ talking: false }); void this.pageCall('holdPushToTalk', [false]); },
    });
    /** Mute and deafen on their back buttons: one toggle per press. */
    private presses = new PressFollower();
    /** What the backend follows during a call: the grips with a job, joined
     *  ('' for presence only); null outside a call. */
    private watching: string | null = null;
    private watchSeq = 0;
    private onButton = (payload: unknown) => {
        if (this.watching === null) return;
        const p = payload && typeof payload === 'object' ? payload as { button?: unknown; held?: unknown } : null;
        if (!p || typeof p.held !== 'boolean') return;
        const job = jobOf(this.snap.settings, p.button);
        if (job === 'pushToTalk') {
            this.hold.signal(p.held);
        } else if (job && this.presses.signal(String(p.button), p.held)) {
            void (job === 'muteButton' ? this.toggleMute() : this.toggleDeafen());
        }
    };
    /** The Deck's own microphone for the call: 'on' from the start of a call
     *  the plugin asked about it until the call ends. */
    private micCall: 'idle' | 'on' = 'idle';
    private buttonToast: { dismiss(): void } | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private loadTimer: ReturnType<typeof setTimeout> | null = null;
    private bootSeq = 0;
    private retries = 0;
    private started = false;
    private updateTimer: ReturnType<typeof setTimeout> | null = null;
    /** Where the offered update comes from, and the key that checked it. */
    private updateFrom: { site: string; offer: UpdateOffer; key: UpdateKey } | null = null;
    private noKeyLogged = false;
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
        this.syncInputWatch();
        this.syncMicForCall();
        this.syncSilentNotice();
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
        void call<[], unknown>('plugin_version').then(
            v => { if (typeof v === 'string') this.update({ pluginVersion: v }); },
            () => {},
        );
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
        if (this.updateTimer) { clearTimeout(this.updateTimer); this.updateTimer = null; }
        this.clearLoadTimer();
        this.hold.reset();
        if (this.watching) {
            this.watching = null;
            this.watchSeq++;
            void call('unwatch_input').catch(() => {});
        }
        void call('cancel_learn').catch(() => {});
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

    /** Voice channels with people in them, across every server the person
     *  is in: the panel's "Live now". */
    async listLiveChannels(): Promise<LiveChannel[]> {
        const state = this.snap.state;
        if (!state?.signedIn) return [];
        const servers = state.servers.slice(0, LIVE_SERVERS_MAX);
        const channels = new Map<string, EmbedVoiceChannel[]>();
        await Promise.all(servers.map(async s => { channels.set(s.id, await this.listVoiceChannels(s.id)); }));
        return liveChannels(servers, channels);
    }

    async join(serverId: string, channelId: number): Promise<string | null> {
        // A join starts call audio: let the page play it as after a click.
        this.view.activate();
        let r = await this.pageCall<{ ok: boolean; error?: string }>('joinVoice', [serverId, channelId]);
        if (!r.ok && r.error === 'unsupported') {
            // Púca is between pages (a reload): its control API comes back
            // with it. Wait for that, then try once more.
            if (await this.untilPageAnswers(JOIN_WAIT_MS)) {
                r = await this.pageCall<{ ok: boolean; error?: string }>('joinVoice', [serverId, channelId]);
            }
        }
        if (!r.ok) return r.error === 'unsupported' ? 'Púca is still starting. Try again in a moment.' : r.error;
        return r.value?.ok ? null : (r.value?.error ?? 'could not join');
    }

    /** Wait until the page's control API answers again, up to ms. */
    private async untilPageAnswers(ms: number): Promise<boolean> {
        const until = Date.now() + ms;
        while (Date.now() < until) {
            const r = await this.pageCall('getState');
            if (r.ok) return true;
            await new Promise(res => setTimeout(res, 400));
        }
        return false;
    }

    leave(): void {
        void this.pageCall('leaveVoice');
    }

    /**
     * Sign in from the panel, through the page's own sign-in form
     * (docs/EMBEDDING.md, signIn). The password goes from the panel to Púca's
     * page inside the Deck and nowhere else; it is never stored or logged.
     * Null when it worked (the page then reports itself signed in), or what
     * to say.
     */
    async signIn(username: string, password: string, staySignedIn: boolean): Promise<string | null> {
        const r = await this.pageCall<{ ok: boolean; error?: string }>('signIn', [username, password, staySignedIn]);
        if (!r.ok) {
            if (r.error === 'unsupported') return 'Púca is still starting. Try again in a moment.';
            // The backend gave up waiting; the sign-in itself may still finish.
            if (r.error === 'TimeoutError') return 'Púca took too long to answer. If it signs you in, this panel will show it.';
            return `Could not sign in: ${r.error}`;
        }
        if (r.value?.ok) return null;
        switch (r.value?.error) {
            case 'invalid': return 'Wrong username or password.';
            case 'reset-required': return 'Your account needs a security update. Open Púca to finish it.';
            case 'unavailable': return 'Púca is not showing its sign-in. Try again in a moment, or open Púca and sign in there.';
            case 'busy': return 'Already signing in…';
            case 'missing': return 'Type your username and password.';
            case 'signed-in': return null;
            default: return `Could not sign in: ${r.value?.error ?? 'no answer'}`;
        }
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
                        this.scheduleUpdateCheck(UPDATE_FIRST_CHECK_MS);
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

    // ---- The microphone's level --------------------------------------------------------

    /** A muted or zeroed system microphone sends silence while everything
     *  else looks fine. The panel says so (Snapshot.micSilent); this pops it
     *  up over the game when the person is trying to be heard (micSilence.ts). */
    private syncSilentNotice(): void {
        if (!this.silentNotice.update(this.snap.micSilent, this.snap.state?.call ?? null, Date.now())) return;
        toaster.toast({
            title: "Your Deck's microphone is muted",
            body: "Nobody can hear you. Turn the microphone up in Steam's Settings, Audio.",
            logo: createElement(PucaIcon, { size: 40 }),
            playSound: this.snap.settings.notificationSound,
        });
    }

    // ---- The Deck's controls: push-to-talk, presence ------------------------------------

    /**
     * The backend reads the controls only during a call: the back grips with
     * a job (push to talk, mute, deafen), and always whether they are in use,
     * which keeps a player out of Púca's AFK move. Runs on every snapshot
     * change; does nothing unless the answer changed.
     */
    private syncInputWatch(): void {
        const buttons = watchedButtons(this.snap.settings);
        const want = this.started && this.snap.state?.call ? buttons.join(',') : null;
        if (want === this.watching) return;
        this.watching = want;
        this.hold.reset();
        this.presses.reset();
        const seq = ++this.watchSeq;
        if (want === null) {
            void call('unwatch_input').catch(() => {});
            if (this.snap.pttError !== null) this.update({ pttError: null });
            return;
        }
        void call<[string[]], CallResult<string | null>>('watch_input', buttons).then(
            r => { if (seq === this.watchSeq) this.update({ pttError: r.ok ? r.value : r.error }); },
            err => { if (seq === this.watchSeq) this.update({ pttError: String((err as Error)?.message ?? err) }); },
        );
    }

    /** Mute or unmute from a back button, and say so over the game. */
    private async toggleMute(): Promise<void> {
        const c = this.snap.state?.call;
        if (!c) return;
        if (c.noMicrophone) {
            this.sayButton('No microphone in this call', 'Join again with a microphone to talk.');
            return;
        }
        const want = !c.muted;
        const r = await this.pageCall<boolean>('setMuted', [want]);
        if (r.ok && r.value === true) this.sayButton(want ? 'Muted' : 'Unmuted', c.channelName);
        else this.sayButton(want ? "Couldn't mute" : "Couldn't unmute", c.deafened ? 'You are deafened.' : 'Púca does not allow it in this channel.');
    }

    /** Deafen or undeafen from a back button, and say so over the game. */
    private async toggleDeafen(): Promise<void> {
        const c = this.snap.state?.call;
        if (!c) return;
        const want = !c.deafened;
        const r = await this.pageCall<boolean>('setDeafened', [want]);
        if (r.ok && r.value === true) this.sayButton(want ? 'Deafened' : 'Undeafened', c.channelName);
        else this.sayButton(want ? "Couldn't deafen" : "Couldn't undeafen", c.channelName);
    }

    /** A short, silent toast for a back button: the panel is not on screen
     *  in a game. A new one replaces the last instead of stacking up. */
    private sayButton(title: string, body: string): void {
        this.buttonToast?.dismiss();
        this.buttonToast = toaster.toast({
            title, body, logo: createElement(PucaIcon, { size: 40 }), playSound: false, duration: 2000,
        });
    }

    /**
     * The Deck's own microphone: switched on when a call starts and it is
     * muted (settings.micForCalls), muted again when the call ends. The
     * setting is read when the call starts, so changing it mid-call never
     * mutes someone who is talking.
     */
    private syncMicForCall(): void {
        const c = this.snap.state?.call;
        const inCall = this.started && !!c && !c.noMicrophone;
        if (inCall && this.micCall === 'idle' && this.snap.settings.micForCalls) {
            this.micCall = 'on';
            void call<[boolean], CallResult<{ changed?: boolean }>>('mic_for_call', true).then(r => {
                if (!r.ok) {
                    console.warn(`[Púca] could not switch the Deck's microphone on: ${r.error}`);
                } else if (r.value.changed && this.micCall === 'on') {
                    this.update({ micSwitchedOn: true });
                    this.sayButton('Microphone on for the call', "Your Deck's microphone was muted. Púca mutes it again when you leave.");
                }
            }, err => console.warn('[Púca] mic_for_call:', err));
        } else if (!inCall && this.micCall === 'on') {
            this.micCall = 'idle';
            if (this.snap.micSwitchedOn) this.update({ micSwitchedOn: false });
            void call<[boolean], unknown>('mic_for_call', false).catch(err => console.warn('[Púca] mic_for_call:', err));
        }
    }

    /** Settings: the back button the person presses next gets `job`.
     *  Choosing by pressing, because R4 and R5 are easy to mix up. A grip has
     *  one job: if another job had it, that one is switched off. */
    async learnButton(job: ButtonJob): Promise<LearnResult> {
        let r: CallResult<string | null>;
        try {
            r = await call<[number], CallResult<string | null>>('learn_button', LEARN_TIMEOUT_S);
        } catch (err) {
            return { error: String((err as Error)?.message ?? err) };
        }
        if (!r.ok) return { error: r.error };
        const button = PUSH_TO_TALK_BUTTONS.find(b => b !== 'off' && b === r.value);
        if (!button || button === 'off') return { button: null };
        const { settings, took } = assignButton(this.snap.settings, job, button);
        await this.saveSettings({ pushToTalk: settings.pushToTalk, muteButton: settings.muteButton, deafenButton: settings.deafenButton });
        return { button, took };
    }

    /** Settings: take `job`'s back button away. */
    clearButton(job: ButtonJob): void {
        void this.saveSettings({ [job]: 'off' });
    }

    cancelLearn(): void {
        void call('cancel_learn').catch(() => {});
    }

    // ---- Updates for the plugin itself --------------------------------------------------

    private scheduleUpdateCheck(ms: number): void {
        if (this.updateTimer) clearTimeout(this.updateTimer);
        this.updateTimer = setTimeout(() => {
            this.updateTimer = null;
            void this.checkForUpdate().finally(() => { if (this.started) this.scheduleUpdateCheck(UPDATE_EVERY_MS); });
        }, ms);
    }

    /**
     * Ask the download site of the person's own Púca server whether a newer
     * plugin is published, and believe it only when the release key signed
     * it (update.ts). Quiet when there is nothing to say: an older Púca that
     * names no download site, a site that publishes no plugin, or a build
     * without a key.
     */
    private async checkForUpdate(): Promise<void> {
        if (this.snap.phase !== 'ready') return;
        const site = await this.pageCall<string | null>('downloadSite');
        if (!site.ok || typeof site.value !== 'string') return;
        type Check = { current?: unknown; key?: unknown; offer?: unknown };
        let r: CallResult<Check>;
        try {
            r = await call<[string], CallResult<Check>>('check_update', site.value);
        } catch (err) {
            console.warn('[Púca] update check failed:', err);
            return;
        }
        if (!r.ok) {
            console.log(`[Púca] update check: ${r.error}`);
            return;
        }
        const current = typeof r.value.current === 'string' ? r.value.current : null;
        const key = readKey(r.value.key);
        const offer = readOffer(r.value.offer);
        if (!key) {
            if (!this.noKeyLogged) console.log('[Púca] this build carries no update key: new versions are installed by hand');
            this.noKeyLogged = true;
            return;
        }
        if (!current || !offer || !isNewer(offer.version, current)) {
            if (this.snap.update && !this.snap.update.busy) this.update({ update: null });
            this.updateFrom = null;
            return;
        }
        if (!await verifyOffer(offer, key)) {
            console.warn(`[Púca] ${site.value} offers ${offer.version}, but it is not signed with this plugin's release key: ignored`);
            return;
        }
        this.updateFrom = { site: site.value, offer, key };
        if (this.snap.update?.version !== offer.version) this.update({ update: { version: offer.version, busy: false, error: null } });
    }

    /**
     * The panel's Update button: download the update, check it again, and
     * hand it to Decky. Decky checks the file against the same SHA-256, asks
     * the person to confirm, and reloads the plugin, which ends a call: so
     * never during one.
     */
    async installUpdate(): Promise<void> {
        const from = this.updateFrom;
        const u = this.snap.update;
        if (!from || !u || u.busy) return;
        if (this.snap.state?.call) {
            this.update({ update: { ...u, error: 'Leave the call first: updating restarts Púca.' } });
            return;
        }
        this.update({ update: { ...u, busy: true, error: null } });
        const fail = (error: string) => this.update({ update: { version: u.version, busy: false, error } });
        type Download = { path?: unknown; offer?: unknown };
        let r: CallResult<Download>;
        try {
            r = await call<[string, string], CallResult<Download>>('download_update', from.site, u.version);
        } catch (err) {
            fail(`The update could not be downloaded: ${String((err as Error)?.message ?? err)}`);
            return;
        }
        if (!r.ok) {
            fail(`The update could not be downloaded: ${r.error}`);
            return;
        }
        // The backend checked the file against this offer's SHA-256. The
        // offer itself must still be the one the release key signed.
        const offer = readOffer(r.value.offer);
        if (!offer || offer.version !== u.version || typeof r.value.path !== 'string' || !await verifyOffer(offer, from.key)) {
            fail('The download site changed the update while it was being fetched. Try again later.');
            return;
        }
        const decky = (window as unknown as { DeckyBackend?: { call?: (route: string, ...args: unknown[]) => Promise<unknown> } }).DeckyBackend;
        if (typeof decky?.call !== 'function') {
            fail('This Decky Loader cannot install it from here. Install the new version from Decky\'s settings instead.');
            return;
        }
        try {
            await decky.call('utilities/install_plugin', `file://${r.value.path}`, 'Púca', offer.version, offer.sha256, 2);
        } catch (err) {
            fail(`Decky could not install it: ${String((err as Error)?.message ?? err)}`);
            return;
        }
        // Decky now shows its own confirmation. If it is cancelled, the button is back.
        this.update({ update: { version: u.version, busy: false, error: null } });
    }
}

export const controller = new Controller();
