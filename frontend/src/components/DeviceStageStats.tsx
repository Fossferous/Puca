/**
 * The desktop stage's stats panel: the live numbers, in rows, over a corner of
 * the picture (Screen › Show stats, or the stats chip in the bar).
 *
 * The in-call viewer has had one for a long time (StreamStatsOverlay); the
 * device stage had only "Copy diagnostics" on the phone and a console global
 * on the desktop, so "why does it feel behind" had no answer you could read
 * while it was happening. Read-only and inert to the pointer — it sits on the
 * input surface and must not catch the clicks meant for the picture — except
 * its one button, which stops its own presses there.
 *
 * "Input to picture" is MEASURED (latencyProbe.ts): from this end sending a
 * probe to the frame that answers it being on screen here, one clock. The
 * comparison runs the probe both with the agent's old timing and its current
 * one, alternating, so a before-and-after is read on the same machines, the
 * same network and the same minute.
 */
import type { LiveStats } from '../api/devices/liveStats';
import type { LatencyComparison, LatencyReading } from '../api/devices/useLatencyProbe';

const ms = (n: number | null) => (n === null ? '—' : `${n} ms`);
const round = (n: number | null) => (n === null ? null : Math.round(n));

export function DeviceStageStats({ stats, latency, comparison, onCompare }: {
    stats: LiveStats | null;
    latency: LatencyReading | null;
    comparison: LatencyComparison;
    onCompare: () => void;
}) {
    const measured = latency?.unavailable
        ? 'not measured (that computer’s Púca is older, or input is going through the server)'
        : latency?.totalMs != null
            ? `${round(latency.totalMs)} ms${latency.hostMs != null ? ` (that computer: ${round(latency.hostMs)} ms)` : ''}`
            : 'measuring…';
    const rows: Array<[string, string]> = stats
        ? [
            ['Input to picture', measured],
            ['Picture', `${stats.frame ?? '—'}${stats.fps !== null ? ` · ${stats.fps} fps` : ''}`],
            ['Bitrate', stats.kbps === null ? '—' : `${(stats.kbps / 1000).toFixed(1)} Mbps`],
            ['Path', stats.path === null ? '—'
                : `${stats.path === 'relay' ? 'relay (TURN)' : 'direct'}${stats.protocol ? ` · ${stats.protocol.toUpperCase()}` : ''}`],
            ['Round trip', ms(stats.rttMs)],
            ['Waiting to show', ms(stats.bufferMs)],
            ['Decode', stats.decodeMs === null ? '—'
                : `${stats.decodeMs} ms${stats.hardwareDecode === null ? '' : stats.hardwareDecode ? ' · hardware' : ' · software'}`],
            ['Lost', stats.lossPct === null ? '—' : `${stats.lossPct}%${stats.freezes ? ` · ${stats.freezes} freeze${stats.freezes === 1 ? '' : 's'}` : ''}`],
            ['Input', stats.inputLane === null ? '—' : stats.inputLane === 'channel' ? 'direct to that computer' : 'through the server'],
        ]
        : [];
    const canCompare = !!latency && !latency.unavailable && latency.totalMs != null;
    return (
        <div className="device-stage-stats" role="status" aria-label="Stream stats">
            {stats ? (
                <table>
                    <tbody>
                        {rows.map(([k, v]) => (
                            <tr key={k}><th scope="row">{k}</th><td>{v}</td></tr>
                        ))}
                    </tbody>
                </table>
            ) : (
                <span>Measuring…</span>
            )}
            {canCompare && (
                <div className="device-stage-stats-compare">
                    {comparison.running
                        ? <span>Comparing — keep still for a few seconds…</span>
                        : comparison.oldMs !== null || comparison.newMs !== null
                            ? <span>Old timing {ms(round(comparison.oldMs))} · now {ms(round(comparison.newMs))}</span>
                            : null}
                    {!comparison.running && (
                        <button
                            type="button"
                            className="device-stage-btn"
                            onPointerDown={e => e.stopPropagation()}
                            onPointerUp={e => e.stopPropagation()}
                            onPointerMove={e => e.stopPropagation()}
                            onClick={onCompare}
                        >
                            Compare with the old timing
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
