/**
 * The REAL StreamStage (and the real docked StreamPip) inside the REAL phone
 * chat chrome, for e2e/iphone-stream-real-browser.mjs.
 *
 * The chrome around the stage — the chat header, the composer, the collapsed
 * voice bar and the bottom nav — is the markup the shipped app rendered on a
 * 390x844 phone in a voice call (real-phone-chrome.json, captured from the
 * live app by `DUMP=<file> node e2e/iphone-stream-live.mjs`), so the CSS lays
 * out the same boxes it does in the app. Chat.tsx is IMPORTED, never rendered:
 * that pulls in every stylesheet the app loads, in the app's own order, so no
 * rule the real page has is missing here.
 *
 * The picture: a canvas captureStream where the engine has one (Chromium);
 * Playwright's Windows WebKit has no MediaStream, so there the tile is laid
 * out with no picture and only the geometry is checked.
 *
 * URL: ?view=stream|chat|pip  &streams=N
 */
import '../../src/index.css';
import '../../src/mobile.css';
import '../../src/phoneLandscape.css';
import '../../src/components/Chat';
import { createRoot, type Root } from 'react-dom/client';
import { StreamStage } from '../../src/components/StreamStage';
import { StreamPip } from '../../src/components/StreamPip';
import { globalScreenSharers, globalSelectedStreams, globalStreamData, notifyStreamStateChange } from '../../src/components/voiceState';
import chrome from './real-phone-chrome.json';
import { installPhoneSideways } from '../../src/api/phoneSideways';

// As main.tsx does: <html data-phone-sideways>, the device turned.
installPhoneSideways();

const params = new URLSearchParams(location.search);
const streams = Number(params.get('streams') ?? '1');
let view = params.get('view') ?? 'stream';

for (const [k, v] of Object.entries(chrome.html)) document.documentElement.setAttribute(k, v);
for (const [k, v] of Object.entries(chrome.body)) document.body.setAttribute(k, v);
const root = document.getElementById('root')!;
root.innerHTML = `<div class="chat-container" data-mobile-panel="chat">${chrome.chatMain}${chrome.nav}</div>`;
document.body.insertAdjacentHTML('beforeend', chrome.voice);

// VoicePanel publishes its measured height for the panels above it to clear.
const panel = document.querySelector<HTMLElement>('.voice-panel-compact')!;
new ResizeObserver(() => {
    document.documentElement.style.setProperty('--mobile-voice-panel-h', `${Math.round(panel.getBoundingClientRect().height)}px`);
}).observe(panel, { box: 'border-box' }); // as VoicePanel.tsx does

// Some messages, so the list has something to show.
const messages = document.querySelector<HTMLElement>('.messages-container')!;
const fillMessages = () => {
    messages.innerHTML = Array.from({ length: 12 }, (_, i) =>
        `<div class="message" style="padding:6px 0">Message ${i + 1}: the list must keep room to read.</div>`).join('');
};

function stand_in(n: number): MediaStream | null {
    const c = document.createElement('canvas');
    if (typeof (c as HTMLCanvasElement & { captureStream?: unknown }).captureStream !== 'function') return null;
    c.width = 1280; c.height = 720;
    const g = c.getContext('2d')!;
    let i = 0;
    setInterval(() => {
        g.fillStyle = `hsl(${(n * 90 + (i += 2)) % 360},55%,38%)`;
        g.fillRect(0, 0, 1280, 720);
        g.fillStyle = '#fff';
        g.font = 'bold 90px sans-serif';
        g.fillText(`STREAM ${n}`, 380, 390);
    }, 50);
    return c.captureStream(20);
}

for (let n = 1; n <= streams; n++) {
    const id = 100 + n;
    globalStreamData.set(id, { username: `Streamer ${n}`, stream: stand_in(n) });
    globalScreenSharers.set(id, `Streamer ${n}`);
    globalSelectedStreams.add(id);
}
notifyStreamStateChange();

let stageRoot: Root | null = null;
let pipRoot: Root | null = null;
const pipHost = document.createElement('div');
pipHost.style.display = 'contents';
document.querySelector('.chat-header')!.after(pipHost);

function show(next: string) {
    view = next;
    document.documentElement.dataset.harnessView = view;
    stageRoot?.unmount(); stageRoot = null;
    pipRoot?.unmount(); pipRoot = null;
    if (view === 'stream') {
        messages.innerHTML = '';
        stageRoot = createRoot(messages);
        stageRoot.render(
            <StreamStage
                currentUserId={1}
                onBackToChat={() => show('chat')}
                onMinimize={() => show('pip')}
            />,
        );
        return;
    }
    fillMessages();
    if (view === 'pip') {
        pipRoot = createRoot(pipHost);
        pipRoot.render(<StreamPip docked onExpand={() => show('stream')} onClose={() => show('chat')} onStopWatching={() => show('chat')} />);
    }
}
show(view);
(window as unknown as { __harness: { show: typeof show } }).__harness = { show };
