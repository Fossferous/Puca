/**
 * Stream stats on a tile: right-click a stream → Show Stream Stats. What a
 * streamer or a viewer needs to judge "how is this stream doing" without
 * DevTools: picture, frame rate, bitrate, codec and whether it is hardware,
 * loss and delay — and on your own share, what is limiting it.
 *
 * Samples once a second, and only while shown (streamStats.ts keeps the
 * previous read, so every number after the first is a one-second rate).
 */
import { useEffect, useRef, useState } from 'react';
import { formatKbps, type StreamStatsView } from '../api/rtc/streamStats';
import { streamStatsSampler } from '../api/rtc/streamStatsLive';
import { CloseIcon } from './Icons';

export const STREAM_STATS_INTERVAL_MS = 1000;

interface Props {
    stream: MediaStream;
    onClose: () => void;
}

const LIMIT_TEXT: Record<string, string> = {
    none: 'nothing',
    cpu: 'CPU (the encoder cannot keep up)',
    bandwidth: 'bandwidth (the connection)',
    other: 'something else',
};

/** 'hardware (D3D11VideoDecoder)' / 'software (OpenH264)' / the name alone. */
function coderText(v: StreamStatsView): string | null {
    const kind = v.hardware === true ? 'hardware' : v.hardware === false ? 'software' : null;
    if (kind && v.implementation) return `${kind} (${v.implementation})`;
    return kind ?? v.implementation;
}

export function StreamStatsOverlay({ stream, onClose }: Props) {
    const [view, setView] = useState<StreamStatsView | null>(null);
    const [ticked, setTicked] = useState(false);
    const busy = useRef(false);

    useEffect(() => {
        const sampler = streamStatsSampler(stream);
        let alive = true;
        const tick = async () => {
            // A slow getStats must not stack reads behind itself.
            if (busy.current) return;
            busy.current = true;
            try {
                const v = await sampler.sample();
                if (alive) { setView(v); setTicked(true); }
            } finally {
                busy.current = false;
            }
        };
        void tick();
        const t = setInterval(() => { void tick(); }, STREAM_STATS_INTERVAL_MS);
        return () => { alive = false; clearInterval(t); };
    }, [stream]);

    const rows: Array<[string, string]> = [];
    if (view) {
        const pending = view.measured ? null : 'measuring…';
        rows.push(['Picture', `${view.size?.replace('x', '×') ?? '—'} · ${view.fps ?? '—'} fps`]);
        const video = pending ?? formatKbps(view.videoKbps)
            + (view.direction === 'outbound' && view.targetKbps !== null ? ` (target ${formatKbps(view.targetKbps)})` : '');
        rows.push(['Video', video]);
        if (view.audioKbps !== null || !view.measured) rows.push(['Audio', pending ?? formatKbps(view.audioKbps)]);
        const coder = coderText(view);
        rows.push(['Codec', [view.codec, coder].filter(Boolean).join(' · ') || '—']);
        if (view.direction === 'outbound') {
            if (view.limit) rows.push(['Limited by', LIMIT_TEXT[view.limit] ?? view.limit]);
            if (view.viewers !== null && view.viewers > 1) rows.push(['Encoded for', `${view.viewers} viewers`]);
        } else {
            rows.push(['Loss', pending ?? (view.lossPct === null ? '—' : `${view.lossPct}%`)]);
            if (view.jitterBufferMs !== null) rows.push(['Buffer', `${view.jitterBufferMs} ms`]);
            if (view.measured) rows.push(['Dropped', `${view.framesDropped ?? 0} frames · ${view.freezes ?? 0} freezes`]);
        }
        rows.push(['Round trip', view.rttMs === null ? '—' : `${view.rttMs} ms`]);
        if (view.transport) rows.push(['Route', view.transport]);
    }

    return (
        <div className="stream-stats-overlay" role="status" aria-label="Stream stats" onClick={(e) => e.stopPropagation()}>
            <div className="stream-stats-head">
                <span>{view?.direction === 'outbound' ? 'Your stream' : 'Stream stats'}</span>
                <button className="stream-stats-close" onClick={onClose} aria-label="Hide stream stats" title="Hide stream stats">
                    <CloseIcon size={12} />
                </button>
            </div>
            {view ? (
                <dl className="stream-stats-rows">
                    {rows.map(([k, v]) => (
                        <div key={k} className="stream-stats-row"><dt>{k}</dt><dd>{v}</dd></div>
                    ))}
                </dl>
            ) : (
                <p className="stream-stats-empty">{ticked ? 'No video is flowing for this stream yet.' : 'Reading…'}</p>
            )}
        </div>
    );
}
