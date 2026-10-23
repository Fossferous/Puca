/**
 * The desktop stage's stats panel: the live numbers, in rows, over a corner of
 * the picture (Screen › Show stats, or the stats chip in the bar).
 *
 * The in-call viewer has had one for a long time (StreamStatsOverlay); the
 * device stage had only "Copy diagnostics" on the phone and a console global
 * on the desktop, so "why does it feel behind" had no answer you could read
 * while it was happening. Read-only and inert to the pointer: it sits on the
 * input surface, so it must not catch the clicks meant for the picture.
 */
import type { LiveStats } from '../api/devices/liveStats';

const ms = (n: number | null) => (n === null ? '—' : `${n} ms`);

export function DeviceStageStats({ stats }: { stats: LiveStats | null }) {
    const rows: Array<[string, string]> = stats
        ? [
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
            ['This end', stats.hereMs === null ? '—' : `about ${stats.hereMs} ms (+ the other computer's capture and encode)`],
        ]
        : [];
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
        </div>
    );
}
