/**
 * Screen coordinates -> normalised position on the remote screen.
 *
 * Lives in its own module (rather than beside the component) because exporting
 * it from a component file breaks React fast refresh, and because it is the
 * kind of logic that must be testable without mounting anything.
 *
 * Why it is fiddly: the video is laid out with `object-fit: contain`, so the
 * picture keeps its aspect ratio inside a differently-shaped box and is offset
 * from the element by black bars. Element coordinates are therefore NOT picture
 * coordinates. Getting this wrong is invisible — the session connects, the
 * picture looks right, and clicks quietly land somewhere else on a machine the
 * user cannot see.
 *
 * Deliberately the same maths as StreamStage's own mapping: the letterboxing is
 * a property of the layout, not of either component.
 */

export interface NormalisedPoint {
    /** 0..1 across the captured screen. */
    x: number;
    y: number;
}

/** Minimal shape needed, so tests need no real video element. */
export interface MappableVideo {
    getBoundingClientRect(): { left: number; top: number; width: number; height: number };
    videoWidth: number;
    videoHeight: number;
}

/** Where the picture actually is inside its box, and how big it is drawn. */
export interface PictureBox {
    /** Left/top of the picture, in whatever space `boxW`/`boxH` were measured. */
    offX: number;
    offY: number;
    /** Size of the drawn picture — always smaller than the box on one axis. */
    dispW: number;
    dispH: number;
}

/**
 * ONE letterbox calculation, shared by everything that needs it.
 *
 * `object-fit: contain` keeps the picture's aspect ratio inside a box shaped
 * differently, so there are black bars on one axis and element coordinates are
 * NOT picture coordinates. Three separate places needed this maths and only two
 * had it: input was letterbox-corrected while the cursor overlay divided by the
 * raw element size, which put the drawn cursor hundreds of pixels away from
 * where the host pointer really was on a phone in portrait.
 *
 * TWO COORDINATE SPACES USE THIS, deliberately:
 *   - Mapping a TOUCH to the remote screen passes `getBoundingClientRect()`
 *     values. That rect is post-transform, so pinch-zoom and pan cancel out of
 *     the maths and aiming stays correct while zoomed.
 *   - Positioning the cursor OVERLAY passes the layout box
 *     (`offsetWidth`/`offsetHeight`), because the overlay lives inside the
 *     element the zoom transform is applied to and must be placed in
 *     pre-transform coordinates — the transform then carries it along with the
 *     picture for free.
 * Passing the wrong one is invisible until you zoom.
 *
 * `null` when nothing is drawable yet: before the first frame `videoWidth` is
 * 0, and a zero-sized element has no picture to speak of.
 */
export function pictureBox(
    videoW: number,
    videoH: number,
    boxW: number,
    boxH: number,
): PictureBox | null {
    if (!videoW || !videoH || boxW <= 0 || boxH <= 0) return null;
    const scale = Math.min(boxW / videoW, boxH / videoH);
    const dispW = videoW * scale;
    const dispH = videoH * scale;
    return {
        offX: (boxW - dispW) / 2,
        offY: (boxH - dispH) / 2,
        dispW,
        dispH,
    };
}

/**
 * `null` when the point is not on the picture: in the letterbox bars, before
 * the first frame has arrived (videoWidth is 0), or on a zero-sized element.
 *
 * Null rather than a clamp, deliberately. Clamping would turn every click in
 * the black region into a real click on the remote screen's edge — a phantom
 * action the user never took.
 */
export function normalizedOverVideo(
    video: MappableVideo,
    clientX: number,
    clientY: number,
): NormalisedPoint | null {
    const rect = video.getBoundingClientRect();
    const box = pictureBox(video.videoWidth, video.videoHeight, rect.width, rect.height);
    if (!box) return null;

    const x = (clientX - (rect.left + box.offX)) / box.dispW;
    const y = (clientY - (rect.top + box.offY)) / box.dispH;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
}

/**
 * `KeyboardEvent.code` values the native injector maps to a scan code.
 *
 * An allowlist, not a blocklist: an unmapped code makes the Rust side return
 * `Err("unmapped key")`, so filtering here keeps a stray media key from
 * producing a stream of errors mid-session.
 */
export function isInjectableKey(code: string): boolean {
    // Must stay in step with `vk_for` in crates/puca-input: a code allowed
    // here but unmapped there is a key that travels the whole way and is
    // dropped at the far end with nothing shown to the user.
    return /^(Key[A-Z]|Digit\d|F\d{1,2}|Numpad\w+|Arrow(Up|Down|Left|Right)|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|Meta(Left|Right)|Escape|Tab|Enter|Space|Backspace|Delete|Home|End|PageUp|PageDown|Insert|CapsLock|NumLock|PrintScreen|ScrollLock|Pause|ContextMenu|Minus|Equal|Bracket(Left|Right)|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash)$/.test(code);
}


/**
 * Normalised picture position -> DOM screen coordinates.
 */
export function videoToScreen(
    video: MappableVideo,
    point: NormalisedPoint
): { x: number, y: number } | null {
    const rect = video.getBoundingClientRect();
    const box = pictureBox(video.videoWidth, video.videoHeight, rect.width, rect.height);
    if (!box) return null;

    return {
        x: rect.left + box.offX + point.x * box.dispW,
        y: rect.top + box.offY + point.y * box.dispH,
    };
}
