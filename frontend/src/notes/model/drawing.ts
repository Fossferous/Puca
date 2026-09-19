/**
 * Púca Notes — the drawing model. A drawing is a list of strokes on a fixed
 * logical canvas; the editor renders it, the note stores it twice: as a PNG
 * (what every card and Púca's own gallery show) and as this JSON (what makes
 * it editable again), each uploaded as its own end-to-end encrypted file.
 *
 * Pure apart from `renderDrawing`, which only needs a 2D context. The parser
 * is TOTAL: the strokes file is decrypted from a sidecar, and a corrupt or
 * hostile one must not throw inside a render or balloon memory — it degrades
 * to "no drawing" and every number is bounded.
 */

export const DRAWING_WIDTH = 1200;
export const DRAWING_HEIGHT = 900;
export const DRAWING_BACKGROUND = '#ffffff';
/** The pen colours: ink first. Drawn on white in every theme, so they are
 *  chosen for white, not for the app's palette. */
export const PEN_COLORS = ['#202124', '#d93025', '#1a73e8', '#188038', '#f29900', '#9334e6'] as const;
export const PEN_WIDTHS = [4, 10, 24] as const;
const MAX_STROKES = 5000;
const MAX_POINTS = 200_000;
/** Largest logical side a strokes file may ask for. The editor's canvas is
 *  this size in pixels: 10,000 x 10,000 would be ~400 MB of bitmap on a
 *  phone; 2400 x 2400 is ~23 MB. */
export const MAX_DRAWING_SIDE = 2400;

export interface Stroke {
    tool: 'pen' | 'eraser';
    color: string;
    width: number;
    /** Flat x,y pairs in logical canvas units. */
    points: number[];
}

export interface DrawingDoc {
    v: 1;
    w: number;
    h: number;
    strokes: Stroke[];
}

export function emptyDrawing(): DrawingDoc {
    return { v: 1, w: DRAWING_WIDTH, h: DRAWING_HEIGHT, strokes: [] };
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

export function serializeDrawing(doc: DrawingDoc): string {
    return JSON.stringify({
        v: 1,
        w: doc.w,
        h: doc.h,
        // Two decimals are far below a pixel at any size the editor shows.
        strokes: doc.strokes.map(s => ({ tool: s.tool, color: s.color, width: s.width, points: s.points.map(n => Math.round(n * 100) / 100) })),
    });
}

/** Parse a strokes file; null for anything that is not a drawing. */
export function parseDrawing(text: string): DrawingDoc | null {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (o.v !== 1 || !Array.isArray(o.strokes)) return null;
    const side = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, MAX_DRAWING_SIDE) : fallback);
    const w = side(o.w, DRAWING_WIDTH);
    const h = side(o.h, DRAWING_HEIGHT);
    const strokes: Stroke[] = [];
    let budget = MAX_POINTS;
    for (const s of o.strokes.slice(0, MAX_STROKES)) {
        if (typeof s !== 'object' || s === null) continue;
        const r = s as Record<string, unknown>;
        if (!Array.isArray(r.points)) continue;
        const pts = r.points.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
        const even = pts.length - (pts.length % 2);
        const take = Math.min(even, budget - (budget % 2));
        if (take < 2) continue;
        budget -= take;
        strokes.push({
            tool: r.tool === 'eraser' ? 'eraser' : 'pen',
            color: typeof r.color === 'string' && COLOR.test(r.color) ? r.color : PEN_COLORS[0],
            width: typeof r.width === 'number' && r.width > 0 && r.width <= 200 ? r.width : PEN_WIDTHS[0],
            points: pts.slice(0, take),
        });
        if (budget < 2) break;
    }
    return { v: 1, w, h, strokes };
}

/** Paint a drawing onto a context scaled so the logical canvas fills
 *  `scale` × its size. The eraser paints the background colour, so the
 *  exported PNG and the editor always agree. */
export function renderDrawing(ctx: CanvasRenderingContext2D, doc: DrawingDoc, scale = 1): void {
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = DRAWING_BACKGROUND;
    ctx.fillRect(0, 0, doc.w, doc.h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of doc.strokes) drawStroke(ctx, s);
    ctx.restore();
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
    ctx.strokeStyle = s.tool === 'eraser' ? DRAWING_BACKGROUND : s.color;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = s.width;
    if (s.points.length === 2) {
        // A tap is a dot.
        ctx.beginPath();
        ctx.arc(s.points[0], s.points[1], s.width / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
    }
    ctx.beginPath();
    ctx.moveTo(s.points[0], s.points[1]);
    for (let i = 2; i < s.points.length; i += 2) ctx.lineTo(s.points[i], s.points[i + 1]);
    ctx.stroke();
}

/** A pointer position (client pixels) in logical canvas units, given the
 *  canvas element's on-screen box. Clamped to the canvas. */
export function toCanvasPoint(
    clientX: number, clientY: number,
    box: { left: number; top: number; width: number; height: number },
    doc: Pick<DrawingDoc, 'w' | 'h'>,
): [number, number] {
    const x = box.width > 0 ? ((clientX - box.left) / box.width) * doc.w : 0;
    const y = box.height > 0 ? ((clientY - box.top) / box.height) * doc.h : 0;
    return [Math.min(doc.w, Math.max(0, x)), Math.min(doc.h, Math.max(0, y))];
}
