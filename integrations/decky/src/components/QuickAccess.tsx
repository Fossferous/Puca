/**
 * The Quick Access menu panel: the call (mute, deafen, leave, who is talking),
 * the voice channels to join, the way into the full Púca view, and the
 * plugin's few settings. Everything about the account lives in Púca itself.
 */
import {
    ButtonItem, DialogButton, DropdownItem, Field, Focusable, PanelSection, PanelSectionRow, SteamSpinner,
    TextField, ToggleField,
} from '@decky/ui';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { controller, type Snapshot } from '../controller';
import type { EmbedCall, EmbedState, EmbedVoiceChannel } from '../protocol';
import type { PushToTalkButton } from '../settings';
import {
    HeadphonesIcon, HeadphonesOffIcon, LeaveIcon, MicIcon, MicOffIcon, NoMicIcon, SpeakingDot,
} from './icons';

export function useSnapshot(): Snapshot {
    const [snap, setSnap] = useState(controller.getSnapshot());
    useEffect(() => controller.subscribe(() => setSnap(controller.getSnapshot())), []);
    return snap;
}

const BUTTON_LABELS: Record<PushToTalkButton, string> = {
    off: 'Off',
    L4: 'L4 (upper left back button)',
    R4: 'R4 (upper right back button)',
    L5: 'L5 (lower left back button)',
    R5: 'R5 (lower right back button)',
};

/** Why the Deck's controls cannot be read, in plain words. */
function controllerProblem(problem: string): string {
    if (problem === 'no-controller') return "Can't find the Deck's controller. Push to talk works with a Steam Deck's own back buttons.";
    if (problem === 'no-access') return "Can't read the Deck's controller on this system.";
    return `The Deck's controller can't be read: ${problem}`;
}

/** What Settings says under Push to talk: the choice, or why it is not working. */
function pushToTalkNote(button: PushToTalkButton, problem: string | null): string {
    if (button === 'off') return 'Off: Púca listens for your voice.';
    if (problem) return controllerProblem(problem);
    return `Hold ${BUTTON_LABELS[button]} to talk, in games too.`;
}

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const muted: CSSProperties = { opacity: 0.7, fontSize: '0.9em' };

export function QuickAccess() {
    const snap = useSnapshot();
    return (
        <>
            <Main snap={snap} />
            <Settings snap={snap} />
        </>
    );
}

function Note({ title, children }: { title: string; children?: ReactNode }) {
    return (
        <PanelSectionRow>
            <Field label={title} description={children} focusable={false} />
        </PanelSectionRow>
    );
}

function OpenButton({ label = 'Open Púca' }: { label?: string }) {
    return (
        <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => controller.openFullView()}>{label}</ButtonItem>
        </PanelSectionRow>
    );
}

function Main({ snap }: { snap: Snapshot }) {
    switch (snap.phase) {
        case 'starting':
        case 'loading':
            return (
                <PanelSection>
                    <PanelSectionRow>
                        <Field label="Starting Púca…" focusable={false}><SteamSpinner style={{ width: 24, height: 24 }} /></Field>
                    </PanelSectionRow>
                </PanelSection>
            );
        case 'no-address':
            return (
                <PanelSection title="Set up Púca">
                    <Note title="Your Púca address">
                        The address you open Púca at in a browser, for example chat.example.com.
                    </Note>
                    <AddressForm initial="" />
                </PanelSection>
            );
        case 'no-game-mode':
            return (
                <PanelSection>
                    <Note title="Waiting for Game Mode">Púca for Steam Deck runs in Game Mode.</Note>
                </PanelSection>
            );
        case 'unsupported':
            return (
                <PanelSection>
                    <Note title="This Púca server needs an update">
                        Its Púca is too old for these controls. Ask whoever runs it to update. You can still open Púca below.
                    </Note>
                    <OpenButton />
                </PanelSection>
            );
        case 'error':
            return (
                <PanelSection>
                    <Note title="Púca is not running">{snap.error}</Note>
                    <PanelSectionRow>
                        <ButtonItem layout="below" onClick={() => controller.reload()}>Try again</ButtonItem>
                    </PanelSectionRow>
                </PanelSection>
            );
        case 'ready':
            return <Ready snap={snap} />;
    }
}

function Ready({ snap }: { snap: Snapshot }) {
    const state = snap.state;
    if (!state) return null;
    if (!state.signedIn) {
        return (
            <PanelSection>
                <Note title="Sign in to Púca">
                    Open Púca and sign in with your own account. Tick Stay signed in and you only do this once.
                </Note>
                <OpenButton label="Open Púca to sign in" />
            </PanelSection>
        );
    }
    return (
        <>
            {state.call && <Call call={state.call} snap={snap} />}
            <Channels state={state} />
            <PanelSection>
                <OpenButton label="Open Púca (messages)" />
                <Note title={`Signed in as ${state.user?.username ?? ''}`} />
            </PanelSection>
        </>
    );
}

function callStatus(call: EmbedCall, snap: Snapshot): string {
    if (!call.connected) return call.connecting ? 'Connecting…' : 'Not connected: open Púca to see why';
    if (call.noMicrophone) return 'In the call without a microphone';
    if (call.deafened) return 'Deafened';
    if (call.muted) return 'Muted';
    if (call.inputMode === 'pushToTalk') {
        const button = snap.settings.pushToTalk;
        return call.holdDown ? 'Talking' : button !== 'off' ? `Hold ${button} to talk` : 'Push to talk';
    }
    return snap.micOn ? 'Microphone on' : 'In the call';
}

function Call({ call, snap }: { call: EmbedCall; snap: Snapshot }) {
    return (
        <PanelSection title={call.channelName || 'Voice call'}>
            <Note title={callStatus(call, snap)} />
            {snap.micSilent && !call.noMicrophone && (
                <Note title="Your Deck's microphone is muted">
                    Nobody can hear you. Turn the microphone up in Steam's Settings, Audio.
                </Note>
            )}
            <PanelSectionRow>
                <Focusable style={{ display: 'flex', gap: 6 }} flow-children="horizontal">
                    <DialogButton
                        style={{ ...row, minWidth: 0, flex: 1, justifyContent: 'center', padding: '8px 4px' }}
                        disabled={!call.connected || call.noMicrophone}
                        onClick={() => controller.setMuted(!call.muted)}
                    >
                        {call.noMicrophone ? <NoMicIcon /> : call.muted ? <MicOffIcon /> : <MicIcon />}
                        {call.noMicrophone ? 'No mic' : call.muted ? 'Unmute' : 'Mute'}
                    </DialogButton>
                    <DialogButton
                        style={{ ...row, minWidth: 0, flex: 1, justifyContent: 'center', padding: '8px 4px' }}
                        disabled={!call.connected}
                        onClick={() => controller.setDeafened(!call.deafened)}
                    >
                        {call.deafened ? <HeadphonesOffIcon /> : <HeadphonesIcon />}
                        {call.deafened ? 'Undeafen' : 'Deafen'}
                    </DialogButton>
                    <DialogButton
                        style={{ ...row, minWidth: 0, flex: 1, justifyContent: 'center', padding: '8px 4px' }}
                        onClick={() => controller.leave()}
                    >
                        <LeaveIcon />
                        Leave
                    </DialogButton>
                </Focusable>
            </PanelSectionRow>
            <PanelSectionRow>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' }}>
                    {call.members.map(m => (
                        <div key={m.id} style={row}>
                            <SpeakingDot speaking={m.speaking} />
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {m.username}{m.self ? ' (you)' : ''}
                            </span>
                            {m.noMicrophone ? <NoMicIcon size={16} /> : m.muted ? <MicOffIcon size={16} /> : null}
                            {m.deafened ? <HeadphonesOffIcon size={16} /> : null}
                        </div>
                    ))}
                </div>
            </PanelSectionRow>
        </PanelSection>
    );
}

function Channels({ state }: { state: EmbedState }) {
    const [serverId, setServerId] = useState<string | null>(state.call?.serverId ?? state.currentServerId ?? state.servers[0]?.id ?? null);
    const [channels, setChannels] = useState<EmbedVoiceChannel[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [joining, setJoining] = useState<number | null>(null);
    const callChannel = state.call?.channelId ?? null;

    useEffect(() => {
        if (!serverId && state.servers[0]) setServerId(state.servers[0].id);
    }, [serverId, state.servers]);

    useEffect(() => {
        if (!serverId) return;
        let live = true;
        const load = () => { void controller.listVoiceChannels(serverId).then(c => { if (live) setChannels(c); }); };
        load();
        // Who is in which channel changes while the panel is open.
        const t = setInterval(load, 10000);
        return () => { live = false; clearInterval(t); };
    }, [serverId, callChannel]);

    if (state.servers.length === 0) {
        return (
            <PanelSection title="Voice channels">
                <Note title="No servers yet">Join a server in Púca first.</Note>
            </PanelSection>
        );
    }

    const join = async (c: EmbedVoiceChannel) => {
        if (!serverId) return;
        setError(null);
        setJoining(c.id);
        const err = await controller.join(serverId, c.id);
        setJoining(null);
        if (err) setError(`Could not join ${c.name}: ${err}`);
    };

    return (
        <PanelSection title="Voice channels">
            {state.servers.length > 1 && (
                <PanelSectionRow>
                    <DropdownItem
                        label="Server"
                        rgOptions={state.servers.map(s => ({ data: s.id, label: s.name }))}
                        selectedOption={serverId}
                        onChange={o => { setChannels(null); setServerId(o.data as string); }}
                    />
                </PanelSectionRow>
            )}
            {channels === null && <Note title="Loading channels…" />}
            {channels !== null && channels.length === 0 && <Note title="This server has no voice channels" />}
            {channels?.map(c => {
                const here = c.id === callChannel;
                const who = c.members.map(m => m.username).join(', ');
                return (
                    <PanelSectionRow key={c.id}>
                        <ButtonItem
                            layout="below"
                            disabled={here || !c.canConnect || joining !== null}
                            description={who ? <span style={muted}>{who}</span> : undefined}
                            onClick={() => { void join(c); }}
                        >
                            {here ? `${c.name}: you are here` : joining === c.id ? `Joining ${c.name}…` : c.name}
                        </ButtonItem>
                    </PanelSectionRow>
                );
            })}
            {error && <Note title={error} />}
        </PanelSection>
    );
}

function AddressForm({ initial, onDone }: { initial: string; onDone?: () => void }) {
    const [value, setValue] = useState(initial);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const save = async () => {
        setSaving(true);
        const err = await controller.setAddress(value);
        setSaving(false);
        setError(err);
        if (!err) onDone?.();
    };
    return (
        <>
            <PanelSectionRow>
                <TextField label="Púca address" value={value} onChange={e => setValue(e.target.value)} />
            </PanelSectionRow>
            {error && <Note title={error} />}
            <PanelSectionRow>
                <ButtonItem layout="below" disabled={saving || !value.trim()} onClick={() => { void save(); }}>
                    {saving ? 'Saving…' : 'Save'}
                </ButtonItem>
            </PanelSectionRow>
        </>
    );
}

/**
 * Push to talk is chosen by pressing the button, not by its name: R4 and R5
 * are easy to mix up (in testing, "R4" was R5 every time).
 */
function PushToTalk({ snap }: { snap: Snapshot }) {
    const choice = snap.settings.pushToTalk;
    const [learning, setLearning] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const learningRef = useRef(false);
    // Closing the panel stops listening: a press later must not change the button.
    useEffect(() => () => { if (learningRef.current) controller.cancelLearn(); }, []);

    const choose = async () => {
        setMessage(null);
        setLearning(true);
        learningRef.current = true;
        const r = await controller.learnButton();
        learningRef.current = false;
        setLearning(false);
        if ('error' in r) setMessage(controllerProblem(r.error));
        else if (r.button === null) setMessage('No back button was pressed.');
    };

    return (
        <>
            <PanelSectionRow>
                <Field
                    label="Push to talk"
                    description={learning ? 'Press the back button you want to use…' : (message ?? pushToTalkNote(choice, snap.pttError))}
                    focusable={false}
                />
            </PanelSectionRow>
            <PanelSectionRow>
                {learning ? (
                    <ButtonItem layout="below" onClick={() => controller.cancelLearn()}>Cancel</ButtonItem>
                ) : (
                    <ButtonItem layout="below" onClick={() => { void choose(); }}>
                        {choice === 'off' ? 'Choose a back button' : 'Choose another back button'}
                    </ButtonItem>
                )}
            </PanelSectionRow>
            {choice !== 'off' && !learning && (
                <PanelSectionRow>
                    <ButtonItem layout="below" onClick={() => { setMessage(null); void controller.saveSettings({ pushToTalk: 'off' }); }}>
                        Turn off push to talk
                    </ButtonItem>
                </PanelSectionRow>
            )}
        </>
    );
}

function Settings({ snap }: { snap: Snapshot }) {
    const s = snap.settings;
    const [editing, setEditing] = useState(false);
    if (snap.phase === 'no-address') return null;
    return (
        <PanelSection title="Settings">
            <PushToTalk snap={snap} />
            <PanelSectionRow>
                <ToggleField
                    label="Notifications"
                    description="Messages pop up over your game."
                    checked={s.notifications}
                    onChange={v => { void controller.saveSettings({ notifications: v }); }}
                />
            </PanelSectionRow>
            <PanelSectionRow>
                <ToggleField
                    label="Notification sound"
                    checked={s.notificationSound}
                    disabled={!s.notifications}
                    onChange={v => { void controller.saveSettings({ notificationSound: v }); }}
                />
            </PanelSectionRow>
            {editing ? (
                <AddressForm initial={s.appUrl} onDone={() => setEditing(false)} />
            ) : (
                <PanelSectionRow>
                    <ButtonItem layout="below" description={s.appUrl} onClick={() => setEditing(true)}>Change Púca address</ButtonItem>
                </PanelSectionRow>
            )}
            <PanelSectionRow>
                <ButtonItem layout="below" onClick={() => controller.reload()}>Reload Púca</ButtonItem>
            </PanelSectionRow>
        </PanelSection>
    );
}
