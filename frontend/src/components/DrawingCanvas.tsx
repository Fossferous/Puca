/**
 * The drawing editor: a fixed logical canvas (api/drawing.ts) scaled
 * to fit, drawn with pointer events so mouse, pen and finger all work, and
 * `touch-action: none` on the canvas so a stroke on a phone draws instead of
 * scrolling the page. Pen, eraser, six ink colours, three widths, undo and
 * clear. Save hands the owner a PNG and the strokes; the owner uploads both
 * (encrypted) as the note's picture and the file that makes it editable.
 *
 * A modal: centred on desktop, full-screen on a phone (DrawingCanvas.css),
 * portaled to body so no transformed ancestor traps it.
 *
 * SHARED: Púca Notes' editor and quick-add open it, and so does a personal
 * list in Púca's own Tasks view — which is why it and its stylesheet live
 * here rather than under notes/, a tree Púca's bundles strip out.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type DrawingFiles } from '../api/noteMedia';
import {
    type DrawingDoc, type Stroke,
    DRAWING_BACKGROUND, PEN_COLORS, PEN_WIDTHS,
    drawStroke, emptyDrawing, renderDrawing, serializeDrawing, toCanvasPoint,
} from '../api/drawing';
import './DrawingCanvas.css';

const COLOR_NAMES: Record<string, string> = {
    '#202124': 'Black', '#d93025': 'Red', '#1a73e8': 'Blue', '#188038': 'Green', '#f29900': 'Orange', '#9334e6': 'Purple',
};
const WIDTH_NAMES = ['Thin', 'Medium', 'Thick'];

interface DrawingCanvasProps {
    /** Strokes to continue from (editing an existing drawing). */
    initial?: DrawingDoc;
    onCancel: () => void;
    /** Resolves true once the owner has stored it; the editor then closes. */
    onSave: (files: DrawingFiles) => Promise<boolean>;
}

export function DrawingCanvas({ initial, onCancel, onSave }: DrawingCanvasProps) {
    const [start] = useState<DrawingDoc>(() => initial ?? emptyDrawing());
    const [doc, setDoc] = useState<DrawingDoc>(start);
    const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
    const [color, setColor] = useState<string>(PEN_COLORS[0]);
    const [width, setWidth] = useState<number>(PEN_WIDTHS[0]);
    const [saving, setSaving] = useState(false);
    // No 2D canvas (an old WebView, jsdom): say so rather than draw nothing.
    const [unsupported] = useState(() => {
        try { return !document.createElement('canvas').getContext('2d'); } catch { return true; }
    });
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const active = useRef<{ id: number; stroke: Stroke } | null>(null);
    const dirty = doc !== start;

    const ctx = useCallback(() => canvasRef.current?.getContext('2d') ?? null, []);

    // Repaint on every committed change (undo, clear, a finished stroke).
    useLayoutEffect(() => {
        const c = ctx();
        if (c) renderDrawing(c, doc);
    }, [doc, ctx]);

    const cancel = useCallback(() => {
        if (dirty && !window.confirm('Discard the changes to this drawing?')) return;
        onCancel();
    }, [dirty, onCancel]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [cancel]);

    const point = (e: React.PointerEvent<HTMLCanvasElement>) => toCanvasPoint(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), doc);

    const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (active.current || saving) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const [x, y] = point(e);
        const stroke: Stroke = { tool, color, width: tool === 'eraser' ? Math.max(width, 24) : width, points: [x, y] };
        active.current = { id: e.pointerId, stroke };
        const c = ctx();
        if (c) drawStroke(c, stroke);
    };
    const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const a = active.current;
        if (!a || a.id !== e.pointerId) return;
        const [x, y] = point(e);
        const pts = a.stroke.points;
        const c = ctx();
        if (c) {
            c.save();
            c.lineCap = 'round';
            c.lineJoin = 'round';
            c.strokeStyle = a.stroke.tool === 'eraser' ? DRAWING_BACKGROUND : a.stroke.color;
            c.lineWidth = a.stroke.width;
            c.beginPath();
            c.moveTo(pts[pts.length - 2], pts[pts.length - 1]);
            c.lineTo(x, y);
            c.stroke();
            c.restore();
        }
        pts.push(x, y);
    };
    const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const a = active.current;
        if (!a || a.id !== e.pointerId) return;
        active.current = null;
        setDoc(d => ({ ...d, strokes: [...d.strokes, a.stroke] }));
    };

    const save = async () => {
        const canvas = canvasRef.current;
        if (!canvas || saving) return;
        setSaving(true);
        try {
            const png = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'));
            if (!png) throw new Error('This browser could not export the drawing');
            const ok = await onSave({ png, strokes: serializeDrawing(doc) });
            if (!ok) setSaving(false);
        } catch (err) {
            console.error('[notes] drawing save failed:', err);
            setSaving(false);
        }
    };

    return createPortal(
        <div className="notes-draw-backdrop" role="dialog" aria-modal="true" aria-label="Drawing">
            <div className="notes-draw">
                <div className="notes-draw-tools" role="toolbar" aria-label="Drawing tools">
                    <button type="button" className={`notes-draw-btn ${tool === 'pen' ? 'active' : ''}`} aria-pressed={tool === 'pen'} onClick={() => setTool('pen')}>Pen</button>
                    <button type="button" className={`notes-draw-btn ${tool === 'eraser' ? 'active' : ''}`} aria-pressed={tool === 'eraser'} onClick={() => setTool('eraser')}>Eraser</button>
                    <span className="notes-draw-sep" />
                    {PEN_COLORS.map(c => (
                        <button
                            key={c}
                            type="button"
                            className={`notes-draw-swatch ${color === c && tool === 'pen' ? 'active' : ''}`}
                            style={{ '--swatch': c } as React.CSSProperties}
                            aria-label={COLOR_NAMES[c] ?? c}
                            aria-pressed={color === c && tool === 'pen'}
                            title={COLOR_NAMES[c] ?? c}
                            onClick={() => { setColor(c); setTool('pen'); }}
                        />
                    ))}
                    <span className="notes-draw-sep" />
                    {PEN_WIDTHS.map((w, i) => (
                        <button key={w} type="button" className={`notes-draw-btn ${width === w ? 'active' : ''}`} aria-pressed={width === w} onClick={() => setWidth(w)}>
                            {WIDTH_NAMES[i]}
                        </button>
                    ))}
                    <span className="notes-draw-sep" />
                    <button type="button" className="notes-draw-btn" disabled={doc.strokes.length === 0} onClick={() => setDoc(d => ({ ...d, strokes: d.strokes.slice(0, -1) }))}>Undo</button>
                    <button type="button" className="notes-draw-btn" disabled={doc.strokes.length === 0} onClick={() => { if (window.confirm('Clear the whole drawing?')) setDoc(d => ({ ...d, strokes: [] })); }}>Clear</button>
                </div>
                <div className="notes-draw-stage">
                    <canvas
                        ref={canvasRef}
                        className="notes-draw-canvas"
                        width={doc.w}
                        height={doc.h}
                        style={{ aspectRatio: `${doc.w} / ${doc.h}` }}
                        onPointerDown={onDown}
                        onPointerMove={onMove}
                        onPointerUp={onUp}
                        onPointerCancel={onUp}
                        aria-label="Drawing canvas"
                    />
                    {unsupported && <div className="notes-draw-unsupported">Drawing isn’t available in this browser.</div>}
                </div>
                <div className="notes-draw-foot">
                    <button type="button" className="notes-textbtn" onClick={cancel} disabled={saving}>Cancel</button>
                    <button type="button" className="notes-textbtn primary" onClick={() => void save()} disabled={saving || unsupported || doc.strokes.length === 0}>
                        {saving ? 'Saving…' : 'Save drawing'}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
