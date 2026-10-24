/**
 * Sharing a screen from inside an embedding host (Púca for Steam Deck;
 * docs/EMBEDDING.md, getDisplayMedia and startShare), pinned in the source
 * text the way streamOnlyWiring.test.ts pins the stream-only bundle. The
 * pieces have their own tests (embedHost.test.ts, embedApi.test.ts,
 * h264Profiles.test.ts); what those cannot see is whether the voice panel and
 * the media layer still CALL them:
 *
 *  - the Share button, and the arrow beside it, show only where a share can
 *    start: inside a host, only if the host supplies the picture (Steam's
 *    browser refuses capture, so the button could only fail there);
 *  - the dialog's Go Live and a host's Share go live through ONE path;
 *  - a host's Share and Stop, and whether this device is sharing, reach
 *    registerEmbedCall, and the host is told when it changes;
 *  - the share's capture goes through the host when there is one;
 *  - and a host's picture is NOT steered to H.264 on a peer-to-peer call.
 *    Steam's browser encodes H.264 for a quarter of VP8's cost, which makes
 *    that tempting, but mesh media encryption (mediaCrypto.ts) leaves VP8's
 *    header sizes in the clear: an H.264 frame sealed that way loses its NAL
 *    framing and the viewer gets no picture (found in review, 2026-10-23).
 *
 * Every pin is checked against the real source AND against mutated copies
 * (applied to a string here, never to the file), so a pin that could not fail
 * fails its own mutation case. Comments are stripped first.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// LF throughout: a checkout may have CRLF, and the pins and mutants below are written with \n.
const read = (rel: string) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const SRC = {
    vp: stripComments(read('components/VoicePanel.tsx')),
    manager: stripComments(read('api/rtc/manager.ts')),
    media: stripComments(read('api/rtc/media.ts')),
};

/** One declaration's text, to the closing brace at its own indentation. */
function body(code: string, decl: string): string | null {
    const start = code.indexOf(decl);
    if (start === -1 || code.indexOf(decl, start + 1) !== -1) return null;
    const lineStart = code.lastIndexOf('\n', start) + 1;
    const indent = /^[ \t]*/.exec(code.slice(lineStart))![0];
    const rest = code.slice(start + decl.length);
    const end = new RegExp(`\\r?\\n${indent}\\}`).exec(rest);
    return end ? rest.slice(0, end.index) : null;
}

function inOrder(s: string | null, ...needles: string[]): boolean {
    if (s === null) return false;
    let at = -1;
    for (const n of needles) {
        const i = s.indexOf(n, at + 1);
        if (i === -1) return false;
        at = i;
    }
    return true;
}

const replace = (from: string, to: string) => (code: string) => code.replace(from, to);

interface Pin {
    name: string;
    src: keyof typeof SRC;
    holds: (code: string) => boolean;
    mutants: Array<[label: string, mutate: (code: string) => string]>;
}

const PINS: Pin[] = [
    {
        name: 'the Share button, and the arrow beside it, show only where a share can start',
        src: 'vp',
        holds: (c) => c.includes('const shareAvailable = screenShareAvailable();')
            && /\{!isMobile && shareAvailable && \(\s*<button\s+className=\{`voice-btn vp-screenshare/.test(c)
            && /\{!isMobile && shareAvailable && \(\s*<button\s+className="voice-btn vp-share-options"/.test(c),
        mutants: [
            ['the Share button ignores the host', replace('{!isMobile && shareAvailable && (\n                            <button\n                                className={`voice-btn vp-screenshare', '{!isMobile && (\n                            <button\n                                className={`voice-btn vp-screenshare')],
            ['the arrow ignores the host', replace('{!isMobile && shareAvailable && (\n                            <button\n                                className="voice-btn vp-share-options"', '{!isMobile && (\n                            <button\n                                className="voice-btn vp-share-options"')],
            ['always available', replace('const shareAvailable = screenShareAvailable();', 'const shareAvailable = true;')],
        ],
    },
    {
        name: "the dialog's Go Live and a host's Share go live through one path, one start at a time",
        src: 'vp',
        holds: (c) => inOrder(c,
            "onGoLive={async (audioChoice, apps) => {",
            "const start = shareStarts.active?.by === 'dialog' ? shareStarts.active : null;",
            'await goLive(audioChoice, apps, start);',
            'shareStarts.end(start);')
            && inOrder(body(c, 'const startHostShare = async (): Promise<EmbedResult> => {'),
                'if (!isInVoiceRef.current) return',
                'if (isScreenSharingRef.current) return { ok: true };',
                "const start = shareStarts.begin('host');",
                "if (!start) return { ok: false, error: 'already starting' };",
                'await webrtcManager.getScreenShareStream({ width: 1280, height: 800, fps: 30, audio: false });',
                "return await goLive('none', undefined, start);",
                'shareStarts.end(start);'),
        mutants: [
            ['the dialog goes its own way', replace('await goLive(audioChoice, apps, start);', 'void audioChoice; void apps;')],
            ['a host share skips Go Live', replace("return await goLive('none', undefined, start);", 'return { ok: true };')],
            ['a host share asks for sound', replace('fps: 30, audio: false });', 'fps: 30, audio: true });')],
            ['two host starts at once', replace("if (!start) return { ok: false, error: 'already starting' };", '')],
            ["a host's start never over", replace("return await goLive('none', undefined, start);\n        } finally {\n            shareStarts.end(start);", "return await goLive('none', undefined, start);\n        } finally {")],
        ],
    },
    {
        name: "the dialog's capture is a start of its own, refused while a host's runs, over when the dialog closes",
        src: 'vp',
        holds: (c) => inOrder(c,
            'onCaptureScreen={async ({ resolution, fps, prefetchApps }) => {',
            "const start = shareStarts.begin('dialog');",
            'if (!start) return null;',
            'await webrtcManager.getScreenShareStream({ width, height, fps, audio: !isDesktop });')
            && /onClose=\{\(\) => \{ setShowStreamSettings\(false\); shareStarting\.end\(\); endDialogStart\(\); \}\}/.test(c)
            && /onCancelAfterCapture=\{\(\) => \{\n\s*shareStarting\.end\(\);\n\s*endDialogStart\(\);/.test(c)
            && /shareStarting\.end\(\);\n\s*shareStarts\.end\(start\);\n\s*webrtcManager\.stopScreenShare\(\);\n\s*return null;/.test(c),
        mutants: [
            ['the dialog captures over a host start', replace("const start = shareStarts.begin('dialog');\n                    if (!start) return null;", "const start = shareStarts.begin('dialog');")],
            ['closing leaves the start held', replace('shareStarting.end(); endDialogStart(); }}', 'shareStarting.end(); }}')],
            ['a cancelled picker holds the start', replace('shareStarting.end();\n                        shareStarts.end(start);\n', 'shareStarting.end();\n')],
        ],
    },
    {
        name: "a host's Share and Stop, and the sharing state, reach registerEmbedCall; a Stop while starting cancels the start",
        src: 'vp',
        holds: (c) => {
            const reg = body(c, 'useEffect(() => registerEmbedCall({');
            return reg !== null
                && reg.includes('sharing: isScreenSharingRef.current,')
                && /startShare: \(\) => \(startHostShareRef\.current\s*\?\s*startHostShareRef\.current\(\)/.test(reg)
                && inOrder(reg, 'stopShare: () => {', 'if (isScreenSharingRef.current) {', 'stopMyScreenShareRef.current?.();', 'return true;', 'return shareStarts.cancel();')
                && c.includes('startHostShareRef.current = startHostShare;')
                && c.includes('useEffect(() => { stopMyScreenShareRef.current = stopMyScreenShare; }, [stopMyScreenShare]);');
        },
        mutants: [
            ['sharing reported as never', replace('sharing: isScreenSharingRef.current,', 'sharing: false,')],
            ['Stop stops nothing', replace('stopMyScreenShareRef.current?.();', '')],
            ['Share never wired', replace('startHostShareRef.current = startHostShare;', '')],
            ['a Stop while starting dropped', replace('return shareStarts.cancel();', 'return false;')],
        ],
    },
    {
        name: 'the picture ending, or any stop of our own, while a share is starting cancels the start',
        src: 'vp',
        holds: (c) => inOrder(body(c, 'const stopMyScreenShare = useCallback(() => {'),
            'if (!isScreenSharingRef.current) {', 'shareStarts.cancel();', 'return;', 'setSharing(false);')
            && c.includes('webrtcManager.setOnScreenShareEnded(stopMyScreenShare);'),
        mutants: [
            ['an end while starting ignored', replace('        if (!isScreenSharingRef.current) {\n            shareStarts.cancel();\n            return;', '        if (!isScreenSharingRef.current) {\n            return;')],
            ['guarded by the lagging state', replace('        if (!isScreenSharingRef.current) {\n            shareStarts.cancel();', '        if (!isScreenSharing) {\n            shareStarts.cancel();')],
        ],
    },
    {
        name: 'Go Live looks again before announcing, after the server answers and before going live, and never goes live without a picture',
        src: 'vp',
        holds: (c) => {
            const live = body(c, 'const goLive = async (audioChoice: GoLiveAudio, apps?: GoLiveApps, start?: ShareStart | null): Promise<EmbedResult> => {');
            return live !== null
                && inOrder(live,
                    "goLiveMark('audio');",
                    'if (!stillWanted(start, picture())) return abandon(false);',
                    'const ack = await wsClient.startScreenShareAcked(',
                    'if (!stillWanted(start, picture())) return abandon(true);',
                    'await webrtcManager.addScreenShareToPeers();',
                    'if (!stillWanted(start, picture())) return abandon(true);',
                    'setSharing(true);')
                && inOrder(live, 'const abandon = (announced: boolean): EmbedResult => {', 'if (announced) {', 'wsClient.stopScreenShare(roomId);', 'webrtcManager.stopScreenShare();');
        },
        mutants: [
            ['announced though stopped', replace("        if (!stillWanted(start, picture())) return abandon(false);\n", '')],
            ['live with a dead picture', (code) => {
                const last = 'if (!stillWanted(start, picture())) return abandon(true);';
                const i = code.lastIndexOf(last);
                return i < 0 ? code : code.slice(0, i) + code.slice(i + last.length);
            }],
            ['the announcement never taken back', replace('            if (announced) {', '            if (false) {')],
        ],
    },
    {
        name: 'the sharing ref changes with the state, everywhere',
        src: 'vp',
        holds: (c) => /const setSharing = useCallback\(\(on: boolean\) => \{\n\s*isScreenSharingRef\.current = on;\n\s*setIsScreenSharing\(on\);\n\s*\}, \[\]\);/.test(c)
            && (c.match(/setIsScreenSharing\(/g) ?? []).length === 1,
        mutants: [
            ['the ref left to the effect', replace('        isScreenSharingRef.current = on;\n        setIsScreenSharing(on);', '        setIsScreenSharing(on);')],
            ['a setter past setSharing', replace('setSharing(true);', 'setIsScreenSharing(true);')],
        ],
    },
    {
        name: 'a host hears when this device starts or stops sharing',
        src: 'vp',
        holds: (c) => /useEffect\(\(\) => \{ notifyEmbedChanged\(\); \},\s*\[[^\]]*\bisScreenSharing\]\);/.test(c),
        mutants: [
            ['not told', replace(', holdKeyDown, isScreenSharing]);', ', holdKeyDown]);')],
        ],
    },
    {
        name: "the share's capture goes through the host when there is one",
        src: 'media',
        holds: (c) => c.includes('this.screenShareStream = await getDisplayMediaForShare(displayMediaOptions);')
            && !c.includes('navigator.mediaDevices.getDisplayMedia('),
        mutants: [
            ['straight to the browser', replace('await getDisplayMediaForShare(displayMediaOptions);', 'await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);')],
        ],
    },
    {
        name: "a mesh share keeps the browser's codec order while mesh encryption knows only VP8's headers",
        src: 'manager',
        holds: (c) => {
            const add = body(c, 'private async addScreenShareTracks(');
            return add !== null
                && inOrder(add, 'const sender = pc.addTrack(track, stream);', 'this.wireSender(userId, sender);')
                && !/setCodecPreferences|preferH264|hostScreenShare/.test(add);
        },
        mutants: [
            ['H.264 forced for a host', replace('const sender = pc.addTrack(track, stream);',
                "const sender = pc.addTrack(track, stream);\n            if (track.kind === 'video' && hostScreenShare()) preferH264OnSender(pc, sender);")],
            ['codecs reordered', replace('const sender = pc.addTrack(track, stream);',
                'const sender = pc.addTrack(track, stream);\n            pc.getTransceivers()[0]?.setCodecPreferences([]);')],
        ],
    },
];

describe.each(PINS)('$name', ({ src, holds, mutants }) => {
    const code = SRC[src];
    it('holds in the source', () => {
        expect(holds(code)).toBe(true);
    });
    it.each(mutants)('goes red when %s', (_label, mutate) => {
        const mutated = mutate(code);
        expect(mutated, 'the mutation must actually change the source').not.toBe(code);
        expect(holds(mutated)).toBe(false);
    });
});
