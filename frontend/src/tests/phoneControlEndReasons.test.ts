/**
 * Every reason the phone gives when it ends a control session ITSELF has its
 * own sentence on the page (api/phoneControl.ts endedWords, shown to the
 * person at the phone). The reasons are read from the Java
 * (frontend/android/phone-control/src/main/java/com/sovereign/app/control):
 * every PhoneControl.end(reason, true), where a refusal passed on after
 * `ControlGate.ends(r)` counts as each refusal ControlGate.ends lets end a
 * session.
 *
 * 0.9.862's review found three that read wrong: "hidden" (one app shared, and
 * it went behind another) and "no-indicator" fell to the bare "Remote control
 * ended.", and Android not giving the service back within 60 s, with the
 * person's switch still on, said the switch had been turned off.
 *
 * What would have to break for it to go red: a reason the Java can send
 * (a new end(..., true), a new case in ControlGate.ends) with no words here;
 * two reasons sharing a sentence; the 60 s wait ending as service-off again;
 * a told end the parser cannot follow (it fails naming the site rather than
 * skipping it).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { endedWords, type PhoneControlEndReason } from '../api/phoneControl';

const dir = resolve(__dirname, '../../android/phone-control/src/main/java/com/sovereign/app/control');

/** Every reason the phone sends, by name. Typed, so a name missing from
 *  PhoneControlEndReason fails the typecheck too. */
const PHONE_SENDS: readonly PhoneControlEndReason[] = [
    'notification', 'indicator', 'locked', 'screen-off', 'service-off', 'service-lost',
    'not-sharing', 'one-app', 'hidden', 'no-indicator',
];

/** The only reasons that share a sentence: both are a Stop the person pressed. */
const SAME_WORDS = ['indicator', 'notification'];

/** Java source with its comments taken out (string and char literals kept). */
function code(src: string): string {
    let out = '';
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === '"' || c === '\'') {
            let j = i + 1;
            while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
            out += src.slice(i, j + 1);
            i = j;
        } else if (c === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            out += '\n';
        } else if (c === '/' && src[i + 1] === '*') {
            const close = src.indexOf('*/', i + 2);
            i = close < 0 ? src.length : close + 1;
            out += ' ';
        } else {
            out += c;
        }
    }
    return out;
}

const files = readdirSync(dir)
    .filter((f) => f.endsWith('.java'))
    .map((f) => ({ cls: f.slice(0, -'.java'.length), src: code(readFileSync(join(dir, f), 'utf8')) }));

/** Every `static final String NAME = "value";`, as Class.NAME. */
const constants = new Map<string, string>();
for (const { cls, src } of files) {
    for (const m of src.matchAll(/\bstatic\s+final\s+String\s+(\w+)\s*=\s*"([^"]*)"\s*;/g)) {
        constants.set(`${cls}.${m[1]}`, m[2]);
    }
}

function constant(ref: string, cls: string): string {
    const v = constants.get(ref.includes('.') ? ref : `${cls}.${ref}`);
    if (v === undefined) throw new Error(`${cls}.java: ${ref} is not a String constant of the control folder`);
    return v;
}

/** The arguments of the call whose "(" is at `open`, split at its own commas. */
function args(src: string, open: number): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = open + 1;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '"') {
            let j = i + 1;
            while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
            i = j;
        } else if (c === '(') {
            depth++;
        } else if (c === ')') {
            depth--;
            if (depth === 0) {
                out.push(src.slice(start, i).trim());
                return out;
            }
        } else if (c === ',' && depth === 1) {
            out.push(src.slice(start, i).trim());
            start = i + 1;
        }
    }
    throw new Error('a call with no closing parenthesis');
}

/** The reasons an argument can be: its string literals and String constants. */
function literalReasons(expr: string, cls: string): string[] {
    const out = [...expr.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    for (const m of expr.replace(/"[^"]*"/g, '').matchAll(/\b(?:[A-Z]\w*\.)?[A-Z][A-Z0-9_]+\b/g)) {
        out.push(constant(m[0], cls));
    }
    return out;
}

/** Every refusal ControlGate.ends says ends a session. */
function endingRefusals(): string[] {
    const gate = files.find((f) => f.cls === 'ControlGate')!.src;
    const at = gate.search(/\bstatic\s+boolean\s+ends\s*\(/);
    const sw = gate.indexOf('switch', at);
    const yes = gate.indexOf('return true;', sw);
    const no = gate.indexOf('return false;', yes);
    if (at < 0 || sw < 0 || yes < 0 || no < 0) throw new Error('ControlGate.ends is not the switch this test reads');
    // Every case before the `return true`, and none between it and `default: return false`.
    expect(gate.slice(yes, no)).not.toMatch(/\bcase\b/);
    return [...gate.slice(sw, yes).matchAll(/\bcase\s+([\w.]+)\s*:/g)].map((m) => constant(m[1], 'ControlGate'));
}

/** `v` reaches this end only after ControlGate.ends(v) said yes: right after
 *  that check, or as the parameter of a one-line forwarder (Injector.Env's
 *  `ending`) whose every caller checks it first. */
function passedOnFromEnds(src: string, at: number, v: string): boolean {
    const before = src.slice(Math.max(0, at - 200), at);
    if (new RegExp(`ControlGate\\.ends\\(\\s*${v}\\s*\\)\\s*\\)\\s*\\{?\\s*$`).test(before)) return true;
    const fwd = new RegExp(`\\bvoid\\s+(\\w+)\\s*\\(\\s*String\\s+${v}\\s*\\)\\s*\\{\\s*$`).exec(before);
    if (!fwd) return false;
    const calls = files.flatMap((f) => [...f.src.matchAll(new RegExp(`\\.${fwd[1]}\\(\\s*(\\w+)\\s*\\)`, 'g'))]
        .map((m) => ({ lead: f.src.slice(Math.max(0, m.index! - 120), m.index!), arg: m[1] })));
    return calls.length > 0 && calls.every(({ lead, arg }) =>
        new RegExp(`if\\s*\\(\\s*ControlGate\\.ends\\(\\s*${arg}\\s*\\)\\s*\\)\\s*\\w+\\s*$`).test(lead));
}

/** reason -> the call sites that send it; and the told ends this cannot follow. */
function toldEnds(): { told: Map<string, string[]>; unfollowed: string[] } {
    const told = new Map<string, string[]>();
    const unfollowed: string[] = [];
    for (const { cls, src } of files) {
        for (const m of src.matchAll(/(?<![\w.])end\s*\(|\bPhoneControl\s*\.\s*end\s*\(/g)) {
            const a = args(src, m.index! + m[0].length - 1);
            if (a.length !== 2 || a[1] !== 'true') continue;
            const site = `${cls}.java: end(${a[0]}, true)`;
            let reasons: string[];
            if (/^[a-z]\w*$/.test(a[0])) {
                reasons = passedOnFromEnds(src, m.index!, a[0]) ? endingRefusals() : [];
            } else {
                reasons = literalReasons(a[0], cls);
            }
            if (reasons.length === 0) unfollowed.push(site);
            for (const r of reasons) told.set(r, [...(told.get(r) ?? []), site]);
        }
    }
    return { told, unfollowed };
}

const GENERIC = endedWords('a reason no phone sends');

describe('the words for a phone ending control itself', () => {
    it('reads every told end in the Java, and the page is told only from PhoneControl.end', () => {
        const { told, unfollowed } = toldEnds();
        expect(unfollowed, 'a told end whose reason this test cannot follow').toEqual([]);
        expect([...told.keys()].sort()).toEqual([...PHONE_SENDS].sort());
        // Listener.ended is called in one place, so every reason goes through end().
        const direct = files.flatMap((f) => [...f.src.matchAll(/\.ended\s*\(/g)].map(() => f.cls));
        expect(direct).toEqual(['PhoneControl']);
    });

    it('every reason the phone sends has words of its own, not the bare "Remote control ended."', () => {
        const { told } = toldEnds();
        for (const [reason, sites] of told) {
            expect(endedWords(reason), `${reason} (${sites.join('; ')})`).not.toBe(GENERIC);
        }
        const byWords = new Map<string, string[]>();
        for (const reason of told.keys()) byWords.set(endedWords(reason), [...(byWords.get(endedWords(reason)) ?? []), reason]);
        const shared = [...byWords.values()].filter((rs) => rs.length > 1).map((rs) => rs.sort());
        expect(shared, 'two reasons that read the same').toEqual([SAME_WORDS]);
    });

    it('a one-app share switched away from says why control ended', () => {
        expect(endedWords('hidden')).toMatch(/no longer on the screen/);
        expect(endedWords('no-indicator')).toMatch(/did not let Púca show who is in control/);
        expect(endedWords('screen-off')).toMatch(/screen went off/);
    });

    it('Android not giving the service back in time does not say the switch was turned off', () => {
        const pc = files.find((f) => f.cls === 'PhoneControl')!.src;
        const m = /\bresumeTimeout\s*=\s*\(\)\s*->\s*end\s*\(/.exec(pc);
        expect(m, 'PhoneControl.resumeTimeout').not.toBeNull();
        const [expr] = args(pc, m!.index + m![0].length - 1);
        const [reason] = literalReasons(expr, 'PhoneControl');
        // It is armed only with the switch still on: off, the session ends at once.
        expect(pc).toMatch(/if\s*\(\s*!serviceEnabled\(\)\s*\)\s*\{\s*end\(ControlGate\.SERVICE_OFF,\s*true\);\s*\}\s*else\s*\{[^}]*postDelayed\(resumeTimeout/);
        expect(reason).not.toBe('service-off');
        expect(endedWords(reason)).not.toMatch(/switched off/);
        expect(endedWords(reason)).toMatch(/still switched on/);
        // CONTROL: the switch really turned off does say so.
        expect(endedWords('service-off')).toMatch(/switched off in Android's settings/);
    });
});
