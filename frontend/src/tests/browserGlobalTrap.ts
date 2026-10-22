/**
 * The tripwire for test files that run WITHOUT a DOM.
 *
 * Every `*.test.ts` runs with node's globals and no DOM
 * (clientNodeEnvironment.ts) unless it says `// @vitest-environment jsdom`
 * (vitest.config.ts): no DOM to build, which is most of what a jsdom file
 * costs. The danger in that default is not a loud failure — `document is not
 * defined` tells the author what to do — but a QUIET one: code that asks
 * `typeof window === 'undefined'`, or reads `navigator.userAgent`, takes a
 * different branch without the DOM and the test goes on passing while it
 * checks something the browser never runs.
 *
 * So there every browser-only global below is an accessor that answers
 * `undefined`, exactly as plain node would, and RECORDS who asked. The file
 * then fails in `afterAll`, naming the global and the caller and saying which
 * pragma to add. Only vitest's own machinery (it probes `typeof window` to
 * pretty-print values and installs fake timers over `requestAnimationFrame`)
 * is let through; a library in node_modules asking is recorded like product
 * code, because a library that takes its node branch under test is a library
 * the test is not exercising as the app does.
 *
 * Assigning one (`globalThis.localStorage = fake`, `vi.stubGlobal`) replaces
 * the accessor with the test's own value: a fake the test installed on
 * purpose is not a silent difference.
 */
import { afterAll } from 'vitest';

// Globals the browser (and jsdom) has and node either lacks — so `typeof X`
// silently changes — or has with different behaviour (navigator's userAgent,
// a real WebSocket where the jsdom setup installs a mock).
const BROWSER_GLOBALS = [
    'window', 'self', 'document', 'navigator', 'location', 'history', 'screen',
    'localStorage', 'sessionStorage', 'indexedDB', 'caches',
    'HTMLElement', 'Element', 'Node', 'DocumentFragment', 'ShadowRoot',
    'HTMLCanvasElement', 'HTMLVideoElement', 'HTMLAudioElement', 'HTMLImageElement', 'Image',
    'MutationObserver', 'ResizeObserver', 'IntersectionObserver',
    'matchMedia', 'getComputedStyle', 'getSelection',
    'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
    'innerWidth', 'innerHeight', 'devicePixelRatio', 'visualViewport',
    'FileReader', 'DOMParser', 'XMLHttpRequest',
    'WebSocket', 'RTCPeerConnection', 'MediaStream', 'AudioContext', 'OffscreenCanvas',
] as const;

// Callers allowed to probe without counting: vitest itself and the assertion
// libraries it bundles. Matched against the file path in the caller's frame.
const VITEST_INTERNALS = /[\\/]node_modules[\\/](?:vitest|@vitest[\\/][^\\/]+|chai|tinyspy|tinyrainbow|@sinonjs[\\/]fake-timers)[\\/]/;

const MARK = Symbol.for('puca.browserGlobalTrap');

function callerOf(stack: string | undefined): string {
    // Frame 0 is "Error", 1 is this getter; the first frame outside this file
    // is the code that read the global.
    const frames = (stack ?? '').split('\n').slice(1).map((l) => l.trim());
    const outside = frames.find((f) => !f.includes('browserGlobalTrap.ts'));
    return outside ?? '<unknown caller>';
}

export function installBrowserGlobalTrap(): void {
    const g = globalThis as Record<PropertyKey, unknown>;
    if (g[MARK]) {
        // A second install means this worker's globals outlived a previous
        // file: test isolation is off, and the trap's bookkeeping would mix
        // files. Refuse rather than misattribute.
        throw new Error('browser-global trap installed twice in one global scope — is vitest isolation off?');
    }
    Object.defineProperty(g, MARK, { value: true });

    const touched = new Map<string, string>();
    for (const name of BROWSER_GLOBALS) {
        Object.defineProperty(g, name, {
            configurable: true,
            enumerable: false,
            get() {
                if (!touched.has(name)) {
                    const caller = callerOf(new Error().stack);
                    if (!VITEST_INTERNALS.test(caller) && !caller.includes('node:internal')) touched.set(name, caller);
                }
                return undefined;
            },
            set(value: unknown) {
                Object.defineProperty(g, name, { configurable: true, enumerable: true, writable: true, value });
            },
        });
    }

    afterAll(() => {
        if (touched.size === 0) return;
        const lines = [...touched].map(([name, caller]) => `  ${name}  read by  ${caller}`);
        throw new Error(
            'This test file runs without a DOM (it has no `// @vitest-environment jsdom` line), but the code it ran read browser globals:\n'
            + lines.join('\n')
            + '\nEach read answered `undefined`, so the code may have taken a branch the app never takes and the tests above '
            + 'passed for the wrong reason. If the code needs the DOM, put `// @vitest-environment jsdom` on the first line of this file. '
            + '(src/tests/browserGlobalTrap.ts explains the trap.)',
        );
    });
}
