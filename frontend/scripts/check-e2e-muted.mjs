#!/usr/bin/env node
/**
 * Every browser a script in e2e/ starts says, in its own launch, that it makes no sound.
 * Part of `npm run lint`.
 *
 * WHY. These scripts run on the owner's own desktop, often with earbuds in, and a test
 * browser that plays a stream, a chime or a call's audio plays it at whatever volume the
 * machine is at. Playwright adds --mute-audio by itself only to a HEADLESS Chromium: a
 * headed run (headless: false, PWDEBUG=1, `npm run e2e:headed`) drops it, and it does
 * nothing at all for Firefox (no volume pref) or WebKit (no such switch). Before this
 * check, 36 Chromium launches relied on that default, six WebKit ones and the Playwright
 * config's launchOptions had nothing, so a debug run or a WebKit page that played
 * anything would have been heard.
 *
 * WHAT IS REQUIRED, per launch (which browser it is goes by what the file imported from
 * Playwright, so `firefox as chromium` is Firefox and a local `chromium` is unknown):
 *   chromium.launch / launchPersistentContext / launchServer   '--mute-audio' in its args, and no
 *                                                              ignoreDefaultArgs that could drop it
 *   firefox.launch / ...                                       firefoxUserPrefs 'media.volume_scale': '0.0'
 *                                                              (a STRING: the pref is one, and Firefox
 *                                                              refuses to start given a number)
 *   webkit.launch                                              muteWebkit(await webkit.launch(...)),
 *                                                              muteWebkit imported from e2e/muted.mjs
 *                                                              (WebKit has no mute switch; that gives
 *                                                              every context an init script that mutes
 *                                                              media elements and Web Audio)
 *   a `launchOptions` object (playwright.config.ts, test.use)  '--mute-audio' in its args
 *   a Playwright Test file (a config, a spec, a test.use)      Chromium only: a browserName or
 *                                                              defaultBrowserType that is not, or a
 *                                                              device that brings WebKit or Firefox
 *                                                              (looked up in Playwright's own list)
 *   chromium.connectOverCDP / connect (a browser the script    listed in ATTACHED below, with where its sound
 *     did not start: an emulator's WebView, the desktop app)   is turned off; a new one fails until reviewed
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS set by a script      '--mute-audio' in it (the desktop app's WebView2)
 *   a launch method taken without calling it (.bind, ['launch'], destructured): fails, so
 *     every launch is one this check reads
 *
 * And two sounds a browser's mute does not reach, because the OS makes them:
 *   - a file that mentions the app's spoken join/leave at all (voiceTTS other than
 *     `voiceTTS: false`, or its checkbox's label) must replace window.speechSynthesis: on
 *     Windows speech goes through the OS speech engine, outside the browser's audio
 *     output, so --mute-audio is not relied on for it;
 *   - a file that grants 'notifications' (the word anywhere beside a permission grant)
 *     must launch Chromium with NativeNotifications in EVERY --disable-features= switch
 *     it passes, because Chromium keeps only the last one, and may launch no Firefox or
 *     WebKit at all (nothing here switches their system notifications off): a native
 *     toast plays Windows' notification sound.
 *
 * Parsed, not grepped: the flag has to be in THIS launch's options, followed through
 * the variables, spreads, .concat()s, ternaries (both sides) and option-building
 * functions the scripts use. Anything it cannot follow is a no: a name that is a
 * parameter, an import or a `let`; a const changed after it is made in a way that could
 * lose the flag (args.splice, opts.args = ..., delete, Object.assign; args.push only adds,
 * except to a list that must hold only harmless entries, such as ignoreDefaultArgs); a
 * spread it cannot read (which could set anything); a `var` that could shadow it; a
 * function that can return nothing. The launch then fails and says so; write the flag
 * where the launch can be seen to have it. Not seen: a change made through an alias or
 * a function the options are handed to, and a grant made over raw CDP.
 *
 *   node scripts/check-e2e-muted.mjs          # e2e/ and playwright.config.ts, as the lint chain runs it
 *   node scripts/check-e2e-muted.mjs <dir>    # every script file there, for the test's fixtures
 *
 * src/tests/e2eMuted.test.ts shows it failing on each shape, and passing the right ones.
 */
import ts from 'typescript';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, '..');
const MUTED_HELPER = join(FRONTEND, 'e2e', 'muted.mjs');

/** Which browser each Playwright device runs: a device brings its own (an iPhone is WebKit). */
const DEVICE_BROWSER = (() => {
    try {
        const { devices } = createRequire(join(FRONTEND, 'package.json'))('playwright-core');
        return new Map(Object.entries(devices).map(([name, d]) => [name, d.defaultBrowserType]));
    } catch {
        return new Map(); // no Playwright here: every device is unknown, so flagged
    }
})();
const PLAYWRIGHT_MODULES = new Set(['@playwright/test', 'playwright', 'playwright-core']);

/**
 * Scripts that ATTACH to a browser they did not start, so there is no launch for the
 * flag to be on. Keyed by path from frontend/, with how many attach calls the file has:
 * a new one fails until someone has read where its sound goes and said so here.
 * Three scripts attach over raw CDP (a WebSocket to a debugging port), which this cannot
 * see: e2e/spike-clips/runner.mjs and s1-manual.mjs, and e2e/tauri-raw-cdp-verify.mjs.
 * Each drives the unmuted dev shell, and each header says to ask before running it.
 */
const EMULATOR = "the debug APK's WebView on a HEADLESS emulator, whose sound is the emulator's: the header has it started -no-window -no-audio, and the script refuses any serial but emulator-NNNN";
const ATTACHED = {
    'e2e/android-camera-flip-live.mjs': { count: 1, why: EMULATOR },
    'e2e/android-control-live.mjs': { count: 1, why: EMULATOR },
    'e2e/android-phone-sweep-live.mjs': { count: 2, why: EMULATOR },
    'e2e/android-shade-keys-live.mjs': { count: 1, why: EMULATOR },
    'e2e/android-share-live.mjs': { count: 1, why: EMULATOR },
    'e2e/csp-smoke-desktop.mjs': { count: 1, why: 'the desktop app this script starts, with --mute-audio in WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS (checked here too)' },
};

const LAUNCH = new Set(['launch', 'launchPersistentContext', 'launchServer']);
const ATTACH = new Set(['connect', 'connectOverCDP']);
const ENGINES = new Set(['chromium', 'firefox', 'webkit']);
const MUTE = '--mute-audio';
const WEBVIEW2 = 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS';
/** An object shape that a spread nobody can read went into: any key may be anything. */
const WILD = Symbol('wild');
/**
 * Methods that can take an element out of an array or write over one; assigning to an
 * element or to length is caught as an assignment.
 */
const MUTATORS = new Set(['pop', 'shift', 'splice', 'fill', 'copyWithin']);
/**
 * Methods that only add. On an args array they cannot lose the flag
 * (args.push('--allow-loopback-in-peer-connection') is fine), so a name grown this way can
 * still be followed where the question is "does it hold the flag?". Where the question is
 * "does it hold ONLY harmless entries?" (ignoreDefaultArgs, the --disable-features rule),
 * adding is exactly the danger, and a grown name is a no.
 */
const GROWERS = new Set(['push', 'unshift', 'sort', 'reverse']);
const MUTATING_STATICS = new Set(['assign', 'defineProperty', 'defineProperties', 'set', 'deleteProperty', 'setPrototypeOf']);

function problemsIn(fileName, text, relName) {
    /** const { chromium } = require('@playwright/test'): the declarations that are imports. */
    const requireDecls = new Set();
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true,
        /\.(c|m)?tsx?$/.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const problems = [];
    const reportAt = (pos, what) => {
        const { line, character } = source.getLineAndCharacterOfPosition(pos);
        problems.push({ line: line + 1, column: character + 1, what });
    };
    const report = (node, what) => reportAt(node.getStart(source), what);

    const unwrap = (e) => {
        while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)
            || ts.isSatisfiesExpression?.(e) || ts.isTypeAssertionExpression(e))) e = e.expression;
        return e;
    };
    const bindsName = (binding, name) => {
        if (ts.isIdentifier(binding)) return binding.text === name;
        if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
            return binding.elements.some((el) => !ts.isOmittedExpression(el) && bindsName(el.name, name));
        }
        return false;
    };
    /** Calls `visit` on every node under `root` that is not inside a nested function. */
    const walkOwnScope = (root, visit) => {
        const walk = (n) => {
            if (n !== root && ts.isFunctionLike(n)) return;
            visit(n);
            ts.forEachChild(n, walk);
        };
        walk(root);
    };
    /** Each scope-wide walk once per scope and name (a long walk declares many names). */
    const memo = (fn) => {
        const byScope = new WeakMap();
        return (scope, name) => {
            let byName = byScope.get(scope);
            if (!byName) byScope.set(scope, byName = new Map());
            if (!byName.has(name)) byName.set(name, fn(scope, name));
            return byName.get(name);
        };
    };
    /** A `var` named `name` anywhere in this function (or file) scope: it hoists over consts outside it. */
    const hoistedVar = memo((scope, name) => {
        let found = false;
        walkOwnScope(scope, (n) => {
            if (ts.isVariableDeclarationList(n) && !(n.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))
                && n.declarations.some((d) => bindsName(d.name, name))) found = true;
        });
        return found;
    });
    /** The root name of a chain like opts.args[0].x, or null. */
    const rootName = (e) => {
        e = unwrap(e);
        while (e && (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e))) e = unwrap(e.expression);
        return e && ts.isIdentifier(e) ? e.text : null;
    };
    /**
     * Is the thing called `name` changed in place anywhere in `scope`? 'mutated' when it may
     * have lost or overwritten something, 'grown' when it was only added to directly
     * (args.push(...)), else null. By name: a shadowing name counts too. Not seen: a change
     * made through an alias or a function it is handed to.
     */
    const mutatedIn = memo((scope, name) => {
        let mutated = false;
        let grown = false;
        const visit = (n) => {
            if (mutated) return;
            if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
                const left = unwrap(n.left);
                if ((ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) && rootName(left) === name) mutated = true;
            }
            if (ts.isDeleteExpression(n) && rootName(n.expression) === name) mutated = true;
            if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
                && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator)) {
                const operand = unwrap(n.operand);
                if ((ts.isPropertyAccessExpression(operand) || ts.isElementAccessExpression(operand)) && rootName(operand) === name) mutated = true;
            }
            if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
                const callee = n.expression;
                const method = callee.name.text;
                if (rootName(callee.expression) === name) {
                    const direct = ts.isIdentifier(unwrap(callee.expression));
                    if (MUTATORS.has(method)) mutated = true;
                    // opts.ignoreDefaultArgs.push(...) grows a list inside: not readable as "only adds".
                    else if (GROWERS.has(method)) { if (direct) grown = true; else mutated = true; }
                }
                const on = unwrap(callee.expression);
                if (ts.isIdentifier(on) && ['Object', 'Reflect'].includes(on.text) && MUTATING_STATICS.has(method)
                    && n.arguments[0] && rootName(n.arguments[0]) === name) mutated = true;
            }
            ts.forEachChild(n, visit);
        };
        visit(scope);
        return mutated ? 'mutated' : grown ? 'grown' : null;
    });

    /** What a name refers to where it is used: the nearest enclosing scope that declares it. */
    const declarationOf = (id) => {
        const name = id.text;
        const scopesPassed = [];
        const inStatements = (statements) => {
            for (const st of statements) {
                if (ts.isVariableStatement(st)) {
                    for (const d of st.declarationList.declarations) {
                        if (ts.isIdentifier(d.name) && d.name.text === name) {
                            // `let x` assigned later, or a `let` that is ever reassigned, cannot be followed.
                            const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
                            return { init: d.initializer, followable: isConst && !!d.initializer, local: true };
                        }
                        if (!ts.isIdentifier(d.name) && bindsName(d.name, name)) {
                            return requireDecls.has(d) ? { followable: false } : { followable: false, local: true };
                        }
                    }
                }
                if (ts.isFunctionDeclaration(st) && st.name?.text === name) return { fn: st, followable: true, local: true };
            }
            return null;
        };
        for (let node = id.parent; node; node = node.parent) {
            if (ts.isFunctionLike(node) || ts.isSourceFile(node)) scopesPassed.push(node);
            if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
                const found = inStatements(node.statements);
                if (found) {
                    if (!found.followable || found.fn) return found;
                    // A var in any function between here and there hoists over it; and a const
                    // object that is changed after it is made is not what its initializer says.
                    if (scopesPassed.some((s) => hoistedVar(s, name))) return { followable: false, local: true };
                    const changed = mutatedIn(node, name);
                    if (changed === 'mutated') return { followable: false, local: true };
                    return { ...found, grown: changed === 'grown' };
                }
            }
            if (ts.isFunctionLike(node) && node.parameters) {
                for (const p of node.parameters) if (bindsName(p.name, name)) return { followable: false, local: true };
            }
            if ((ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node))
                && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
                for (const d of node.initializer.declarations) if (bindsName(d.name, name)) return { followable: false, local: true };
            }
            if (ts.isCatchClause(node) && node.variableDeclaration && bindsName(node.variableDeclaration.name, name)) return { followable: false, local: true };
        }
        // An import, or a global: whatever it is, it is not in this file to read.
        return { followable: false };
    };

    /** Does this statement always end in a return or a throw? (If not, the function may give undefined.) */
    const ends = (st) => {
        if (!st) return false;
        if (ts.isReturnStatement(st) || ts.isThrowStatement(st)) return true;
        if (ts.isBlock(st)) return st.statements.some(ends);
        if (ts.isIfStatement(st)) return !!st.elseStatement && ends(st.thenStatement) && ends(st.elseStatement);
        if (ts.isTryStatement(st)) {
            return (ends(st.tryBlock) && (!st.catchClause || ends(st.catchClause.block))) || (!!st.finallyBlock && ends(st.finallyBlock));
        }
        return false;
    };
    /**
     * Every expression a function call can give back (arrow bodies and return statements),
     * with undefined among them when it can run off its end or `return;`.
     */
    const returnsOf = (fn) => {
        if (!fn.body) return [];
        if (!ts.isBlock(fn.body)) return [fn.body];
        const out = [];
        walkOwnScope(fn.body, (n) => { if (ts.isReturnStatement(n)) out.push(n.expression); });
        if (!ends(fn.body)) out.push(undefined);
        return out;
    };
    const functionOf = (callee) => {
        callee = unwrap(callee);
        if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) return callee;
        if (!ts.isIdentifier(callee)) return null;
        const d = declarationOf(callee);
        if (d.fn) return d.fn;
        const init = d.followable ? unwrap(d.init) : null;
        return init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : null;
    };

    /**
     * Does this expression DEFINITELY satisfy `test`? `test` sees only object/array/literal
     * nodes; names, calls and ternaries are followed here, and anything that cannot be
     * followed is a no. Every path must satisfy it (both sides of a ternary, every return).
     */
    const definitely = (expr, test, seen = new Set()) => {
        expr = unwrap(expr);
        if (!expr || seen.has(expr) || seen.size > 60) return false;
        seen = new Set(seen).add(expr);
        if (ts.isIdentifier(expr)) {
            const d = declarationOf(expr);
            return d.followable && !d.fn && !(d.grown && test.strict) && definitely(d.init, test, seen);
        }
        if (ts.isConditionalExpression(expr)) return definitely(expr.whenTrue, test, seen) && definitely(expr.whenFalse, test, seen);
        if (ts.isBinaryExpression(expr) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(expr.operatorToken.kind)) {
            return definitely(expr.left, test, seen) && definitely(expr.right, test, seen);
        }
        if (ts.isAwaitExpression(expr)) return definitely(expr.expression, test, seen);
        if (ts.isCallExpression(expr)) {
            const fn = functionOf(expr.expression);
            if (fn) {
                const rets = returnsOf(fn);
                return rets.length > 0 && rets.every((r) => definitely(r, test, seen));
            }
        }
        return test(expr, seen);
    };

    const stringOf = (e) => {
        e = unwrap(e);
        return e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : null;
    };

    /** An array expression that certainly holds an element `ok` says yes to. */
    const arrayHolds = (ok) => {
        const test = (e, seen) => {
            if (ts.isArrayLiteralExpression(e)) {
                return e.elements.some((el) => ts.isSpreadElement(el)
                    ? definitely(el.expression, test, seen)
                    : (stringOf(el) !== null && ok(stringOf(el))));
            }
            if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
                const method = e.expression.name.text;
                if (method === 'concat') {
                    return definitely(e.expression.expression, test, seen) || e.arguments.some((a) => definitely(a, test, seen));
                }
                // filter(Boolean) keeps every non-empty string, the flag among them.
                if (method === 'filter' && e.arguments.length === 1 && ts.isIdentifier(e.arguments[0]) && e.arguments[0].text === 'Boolean') {
                    return definitely(e.expression.expression, test, seen);
                }
            }
            return false;
        };
        return test;
    };
    /** An array expression that certainly holds only strings `ok` says yes to (an empty one does). */
    const arrayOnly = (ok) => {
        const test = (e, seen) => ts.isArrayLiteralExpression(e) && e.elements.every((el) => ts.isSpreadElement(el)
            ? definitely(el.expression, test, seen)
            : (stringOf(el) !== null && ok(stringOf(el))));
        test.strict = true;
        return test;
    };
    /** Marks a test as one where a name that was only added to cannot be trusted. */
    const strict = (test) => Object.assign(test, { strict: true });

    const keyOf = (p) => {
        if (!p.name) return null;
        if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name)) return p.name.text;
        if (ts.isComputedPropertyName(p.name)) return stringOf(p.name.expression);
        return null;
    };
    /**
     * Every shape an object expression can have at run time: a Map from each key to the
     * expression that last wrote it, one Map per path through its ternaries, spreads and
     * option-building functions; null for a path that cannot be read. A spread that cannot
     * be read leaves a WILD shape: what it may have set is unknown, so only a key written
     * after it can be read.
     */
    const shapes = (expr, seen = new Set()) => {
        expr = unwrap(expr);
        if (!expr || seen.has(expr) || seen.size > 60) return [null];
        seen = new Set(seen).add(expr);
        if (ts.isIdentifier(expr)) {
            const d = declarationOf(expr);
            return d.followable && !d.fn ? shapes(d.init, seen) : [null];
        }
        if (ts.isConditionalExpression(expr)) return [...shapes(expr.whenTrue, seen), ...shapes(expr.whenFalse, seen)];
        if (ts.isBinaryExpression(expr) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(expr.operatorToken.kind)) {
            return [...shapes(expr.left, seen), ...shapes(expr.right, seen)];
        }
        if (ts.isAwaitExpression(expr)) return shapes(expr.expression, seen);
        if (ts.isCallExpression(expr)) {
            const fn = functionOf(expr.expression);
            const rets = fn ? returnsOf(fn) : [];
            return rets.length ? rets.flatMap((r) => shapes(r, seen)) : [null];
        }
        if (!ts.isObjectLiteralExpression(expr)) return [null];
        let maps = [new Map()];
        for (const p of expr.properties) {
            if (ts.isSpreadAssignment(p)) {
                const subs = shapes(p.expression, seen);
                maps = maps.flatMap((m) => subs.map((s) => {
                    if (!s) return new Map([[WILD, true]]);
                    return s.has(WILD) ? new Map(s) : new Map([...m, ...s]);
                }));
            } else {
                const key = keyOf(p);
                const value = ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : null;
                maps = maps.map((m) => (key === null ? new Map([[WILD, true]]) : new Map(m).set(key, value)));
            }
            if (maps.length > 64) return [null];
        }
        return maps;
    };
    const outer = (e, seen) => new Set([...seen].filter((n) => n !== unwrap(e)));
    /** An object expression whose `key`, on every path, certainly satisfies `valueOk`. */
    const objectHas = (key, valueOk) => (e, seen = new Set()) => shapes(e, outer(e, seen))
        .every((m) => m && m.get(key) && definitely(m.get(key), valueOk, seen));
    /** An object expression where `key`, on every path, is certainly absent or satisfies `valueOk`. */
    const objectLacksOr = (key, valueOk) => (e, seen = new Set()) => shapes(e, outer(e, seen))
        .every((m) => m && (m.has(key) ? m.get(key) && definitely(m.get(key), valueOk, seen) : !m.has(WILD)));

    /** The pref is a string pref ("1.0" by default); a number makes Firefox refuse to start. */
    const isZeroString = (e) => {
        const s = stringOf(e);
        return s !== null && /^\s*[+-]?0*(\.0*)?\s*$/.test(s) && /0/.test(s);
    };
    const isBoolean = (e) => e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword;
    const keepsMute = strict((e, seen) => isBoolean(e) || arrayOnly((s) => s !== MUTE)(e, seen));

    const chromiumMuted = (e, seen) => objectHas('args', arrayHolds((s) => s === MUTE))(e, seen)
        && objectLacksOr('ignoreDefaultArgs', keepsMute)(e, seen);
    const firefoxMuted = objectHas('firefoxUserPrefs', objectHas('media.volume_scale', isZeroString));
    // Chromium keeps only the LAST --disable-features= switch, so every one in the args must
    // name NativeNotifications, and nothing that cannot be read may add another.
    const disablesFeatures = (s) => /^--disable-features=/.test(s);
    const disablesToasts = (s) => disablesFeatures(s) && s.slice(19).split(',').includes('NativeNotifications');
    const noNativeToasts = objectHas('args', strict((e, seen) => arrayHolds(disablesToasts)(e, seen)
        && arrayOnly((s) => !disablesFeatures(s) || disablesToasts(s))(e, seen)));

    // Granted however it is spelled (a variable, a list built elsewhere): the word is the tell.
    const grantsNotifications = /['"`]notifications['"`]/.test(text) && /\bgrantPermissions\b|\bpermissions\s*:/.test(text);
    // Playwright Test reads its browser from these: a config, a spec, a test.use().
    const isRunner = /\bdefineConfig\s*\(/.test(text) || /\btest\.use\s*\(/.test(text)
        || /\.(spec|test)\.[cm]?[jt]s$/.test(fileName) || /(^|[\\/])playwright\.config\.[cm]?[jt]s$/.test(fileName);

    /** Named imports from Playwright and from the helper, by local name. */
    const imported = new Map();
    const namespaces = new Set();
    for (const st of source.statements) {
        if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
        const from = st.moduleSpecifier.text;
        const bindings = st.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings) && PLAYWRIGHT_MODULES.has(from)) namespaces.add(bindings.name.text);
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        for (const el of bindings.elements) {
            imported.set(el.name.text, { name: (el.propertyName ?? el.name).text, from });
        }
    }
    // const { chromium } = require('@playwright/test') / await import('playwright') count as imports.
    const moduleOf = (e) => {
        e = unwrap(e);
        if (e && ts.isAwaitExpression(e)) e = unwrap(e.expression);
        if (!e || !ts.isCallExpression(e) || !e.arguments[0]) return null;
        const callee = e.expression;
        const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
        const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
        return isRequire || isImport ? stringOf(e.arguments[0]) : null;
    };
    const requiredBindings = [];
    const findRequires = (n) => {
        if (ts.isVariableDeclaration(n) && n.initializer && ts.isObjectBindingPattern(n.name)) {
            const from = moduleOf(n.initializer);
            if (from) {
                requireDecls.add(n);
                for (const el of n.name.elements) {
                    const key = (el.propertyName ?? el.name).getText(source);
                    if (ts.isIdentifier(el.name)) imported.set(el.name.text, { name: key, from });
                    else if (PLAYWRIGHT_MODULES.has(from) && ENGINES.has(key)) requiredBindings.push({ engine: key, pattern: el.name });
                }
            }
        }
        ts.forEachChild(n, findRequires);
    };
    findRequires(source);
    /**
     * Which browser an expression is: a name imported from Playwright is the engine it was
     * imported as (`firefox as chromium` is Firefox); a name declared in the file is
     * anyone's guess; an undeclared one (a fixture) goes by its name.
     */
    const engineOf = (obj) => {
        obj = unwrap(obj);
        if (ts.isIdentifier(obj)) {
            const imp = imported.get(obj.text);
            if (imp && !PLAYWRIGHT_MODULES.has(imp.from)) return null;
            if (!imp && !ENGINES.has(obj.text)) return null; // only an engine's own name can be one
            // A parameter or variable of that name shadows the import: anyone's guess.
            if (declarationOf(obj).local) return null;
            return imp ? imp.name : obj.text;
        }
        if (ts.isPropertyAccessExpression(obj) && ts.isIdentifier(unwrap(obj.expression)) && namespaces.has(unwrap(obj.expression).text)) return obj.name.text;
        return null;
    };
    const fixtureRoot = process.argv[2] ? resolve(process.argv[2]) : null;
    /** e2e/muted.mjs itself (or, for the test's fixtures, muted.mjs at their root). */
    const isHelper = (from) => {
        const at = resolve(dirname(fileName), from);
        return at === MUTED_HELPER || (fixtureRoot !== null && at === join(fixtureRoot, 'muted.mjs'));
    };
    const importsMuteWebkit = [...imported].some(([local, imp]) => local === 'muteWebkit' && imp.name === 'muteWebkit' && isHelper(imp.from));
    /** muteWebkit(await webkit.launch(...)): the browser, not the promise of one. */
    const wrappedByMuteWebkit = (call) => {
        let n = call;
        let awaited = false;
        while (ts.isAwaitExpression(n.parent) || ts.isParenthesizedExpression(n.parent)) {
            if (ts.isAwaitExpression(n.parent)) awaited = true;
            n = n.parent;
        }
        const p = n.parent;
        return awaited && ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'muteWebkit'
            && !declarationOf(p.expression).local // the import, not a stand-in of the same name
            && p.arguments[0] === n;
    };
    const wordsOf = (value) => {
        const v = unwrap(value);
        if (v && ts.isTemplateExpression(v)) return [v.head.text, ...v.templateSpans.map((s) => s.literal.text)].join(' ');
        return stringOf(v) ?? '';
    };
    const checkWebview2 = (node, value) => {
        if (!wordsOf(value).split(/\s+/).includes(MUTE)) report(node, `${WEBVIEW2} starts the desktop app's WebView2 unmuted: add '${MUTE}' to it`);
    };
    // The app's spoken join/leave, however it is reached: the setting by name (a property,
    // an updateSetting call, saved JSON) or its checkbox by its label. Only `voiceTTS: false`
    // is plainly off.
    const speechReplaced = /defineProperty\(\s*window\s*,\s*['"]speechSynthesis['"]/.test(text);
    const ttsMention = /voiceTTS(?!['"]?\s*:\s*false\b)|Speak Join\/Leave/i.exec(text);
    if (ttsMention && !speechReplaced) {
        reportAt(ttsMention.index, 'the spoken join/leave (voiceTTS) may be turned on with the real speechSynthesis: replace window.speechSynthesis first (Object.defineProperty(window, \'speechSynthesis\', ...)); --mute-audio is not relied on to reach the OS speech engine');
    }
    const memberName = (e) => (ts.isPropertyAccessExpression(e) ? e.name.text
        : ts.isElementAccessExpression(e) ? stringOf(e.argumentExpression) : null);

    let attaches = [];
    const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
            const method = node.expression.name.text;
            const engine = engineOf(node.expression.expression);
            if (LAUNCH.has(method)) {
                const opts = method === 'launchPersistentContext' ? node.arguments[1] : node.arguments[0];
                const where = `${engine ?? node.expression.expression.getText(source)}.${method}()`;
                if (!ENGINES.has(engine)) {
                    report(node, `${where}: cannot tell which browser this starts, so not how it is muted: call chromium/firefox/webkit.${method} by name`);
                } else if (engine === 'chromium') {
                    if (!opts || !definitely(opts, chromiumMuted)) {
                        report(node, `${where} does not say '${MUTE}' where this check can follow it: put it in its args (Playwright adds it only to a headless Chromium; a headed or PWDEBUG run drops it), with no ignoreDefaultArgs that could take it out`);
                    } else if (grantsNotifications && !definitely(opts, noNativeToasts)) {
                        report(node, `${where} in a file that grants notifications: add '--disable-features=NativeNotifications' to its args, or a Windows toast plays its sound`);
                    }
                } else if (engine === 'firefox') {
                    if (!opts || !definitely(opts, firefoxMuted)) report(node, `${where} is not muted (Playwright sets no volume for Firefox): give it firefoxUserPrefs { 'media.volume_scale': '0.0' }, a string`);
                } else if (method !== 'launch' || !wrappedByMuteWebkit(node) || !importsMuteWebkit) {
                    report(node, `${where} is not muted (WebKit has no switch for it): muteWebkit(await webkit.launch(...)), with muteWebkit imported from e2e/muted.mjs`);
                }
                // Only Chromium's native toasts are known here to be switched off.
                if (engine !== 'chromium' && ENGINES.has(engine) && grantsNotifications) {
                    report(node, `${where} in a file that grants notifications: grant them only to Chromium launched with '--disable-features=NativeNotifications' (${engine}'s own system notifications are not switched off here, and a Windows toast plays its sound)`);
                }
            } else if (ATTACH.has(method) && ENGINES.has(engine)) {
                attaches.push(node);
            }
        }
        // A launch method taken without being called right there: nothing above reads it.
        if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && ENGINES.has(engineOf(node.expression))) {
            const name = memberName(node);
            const called = ts.isCallExpression(node.parent) && node.parent.expression === node;
            if (name && (LAUNCH.has(name) || ATTACH.has(name)) && (!called || ts.isElementAccessExpression(node))) {
                report(node, `${engineOf(node.expression)}.${name} taken without calling it here: call ${engineOf(node.expression)}.${name}(...) directly, so its options can be checked`);
            }
        }
        if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && ENGINES.has(engineOf(node.initializer))) {
            for (const el of node.name.elements) {
                const name = (el.propertyName ?? el.name).getText(source);
                if (LAUNCH.has(name) || ATTACH.has(name)) report(el, `${name} destructured from ${engineOf(node.initializer)}: call ${engineOf(node.initializer)}.${name}(...) directly, so its options can be checked`);
            }
        }
        if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
            const key = keyOf(node);
            const value = ts.isPropertyAssignment(node) ? node.initializer : node.name;
            if (key === 'launchOptions' && !definitely(value, chromiumMuted)) {
                report(node, `launchOptions does not say '${MUTE}' where this check can follow it: put it in its args`);
            }
            if (key === WEBVIEW2) checkWebview2(node, value);
            if (isRunner && (key === 'browserName' || key === 'defaultBrowserType') && stringOf(value) !== 'chromium') {
                report(node, `${key} ${stringOf(value) ?? '(not readable)'} for Playwright Test: launchOptions' '${MUTE}' is a Chromium switch, and a test here has no muteWebkit; keep it Chromium`);
            }
        }
        if (isRunner && ts.isElementAccessExpression(node) && ts.isIdentifier(unwrap(node.expression)) && unwrap(node.expression).text === 'devices') {
            const device = stringOf(node.argumentExpression);
            const browser = device ? DEVICE_BROWSER.get(device) : undefined;
            if (browser !== 'chromium') {
                report(node, `devices['${device ?? '?'}'] runs ${browser ?? 'a browser this cannot tell'} in Playwright Test (a device brings its own browser), which launchOptions' '${MUTE}' does not reach`);
            }
        }
        // process.env.X = ... and env['X'] = ...
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const left = unwrap(node.left);
            const name = left && (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) ? memberName(left) : null;
            if (name === WEBVIEW2) checkWebview2(node, node.right);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    // const { chromium: { launch } } = await import('playwright')
    for (const { engine, pattern } of requiredBindings) {
        if (!ts.isObjectBindingPattern(pattern)) continue;
        for (const el of pattern.elements) {
            const name = (el.propertyName ?? el.name).getText(source);
            if (LAUNCH.has(name) || ATTACH.has(name)) report(el, `${name} destructured from ${engine}: call ${engine}.${name}(...) directly, so its options can be checked`);
        }
    }

    if (attaches.length) {
        const reviewed = ATTACHED[relName];
        if (!reviewed || reviewed.count !== attaches.length) {
            for (const a of attaches) {
                report(a, `attaches to a browser it did not start (${attaches.length} in this file${reviewed ? `, ${reviewed.count} reviewed` : ''}): say where its sound is turned off in ATTACHED in scripts/check-e2e-muted.mjs`);
            }
        }
    }
    return problems;
}

function scriptsUnder(dir) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) found.push(...scriptsUnder(path));
        } else if (/\.(m|c)?(j|t)s$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.d.mts')) {
            found.push(path);
        }
    }
    return found;
}

const fixtureDir = process.argv[2] ? resolve(process.argv[2]) : null;
const root = fixtureDir ?? FRONTEND;
const files = fixtureDir
    ? scriptsUnder(fixtureDir)
    : [...scriptsUnder(join(FRONTEND, 'e2e')), join(FRONTEND, 'playwright.config.ts')].filter((f) => existsSync(f));
let failed = 0;
for (const file of files) {
    const rel = relative(root, file).replaceAll('\\', '/');
    for (const p of problemsIn(file, readFileSync(file, 'utf8'), rel)) {
        failed++;
        console.error(`${rel}:${p.line}:${p.column}  ${p.what}`);
    }
}
if (!fixtureDir) {
    for (const rel of Object.keys(ATTACHED)) {
        if (!existsSync(join(FRONTEND, rel))) { failed++; console.error(`${rel}  is in ATTACHED in scripts/check-e2e-muted.mjs but does not exist: take it out`); }
    }
}
if (failed > 0) {
    console.error(`\ncheck-e2e-muted: ${failed} problem(s) in ${files.length} files`);
    process.exit(1);
}
console.log(`check-e2e-muted: ${files.length} files, every browser started muted`);
