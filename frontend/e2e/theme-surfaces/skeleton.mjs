// The app's JSX as markup, read from the source, for measuring colours under the real stylesheet.
//
// A colour is decided by which classes sit inside which, and those live in the source. So this does
// not copy any markup into a fixture, where it could go stale: it parses every .tsx (TypeScript's own
// parser) and renders an element's JSX subtree as plain HTML, with the components it uses inlined and
// `{children}` filled in from the call site. Text becomes "Sample", an icon a small currentColor box.
// Nothing runs, so a surface inline in a 7000-line component costs the same as a small one, and a
// branch no fixture would reach is still measured.
//
// It also follows JSX held in a local (`const body = (...)`, `renderRow()`) to where it is named, a
// literal inline colour (style={{ background: 'transparent' }}), and where each component is used
// (placesOf). What it cannot see is a class computed in a helper function, a colour set from
// JavaScript, and JSX another module hands back (a hook's `{undo.bar}`).
// light-surfaces-real-browser.mjs mounts real components too, and holds the two readings together.

import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { if (name !== 'tests') walk(path, out); } else if (name.endsWith('.tsx')) out.push(path);
    }
    return out;
};

// `side`: 'all' takes both arms of every ternary, 'first' and 'second' one arm each. Both arms at
// once is a class pair no instance has (`danger` and `primary` on one button), so the sweep reads
// each arm on its own.
// `ands`: false leaves out what an && adds, for the reading with no modifier on.
const classNames = (node, into = [], side = 'all', ands = true) => {
    if (!node) return into;
    if (ts.isStringLiteralLike(node)) { into.push(node.text); return into; }
    if (ts.isTemplateExpression(node)) {
        into.push(node.head.text);
        for (const span of node.templateSpans) { classNames(span.expression, into, side, ands); into.push(span.literal.text); }
        return into;
    }
    // The test of a ternary or an && names a value, not a class.
    if (ts.isConditionalExpression(node)) {
        if (side !== 'second') classNames(node.whenTrue, into, side, ands);
        if (side !== 'first') classNames(node.whenFalse, into, side, ands);
        return into;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return ands ? classNames(node.right, into, side, ands) : into;
    ts.forEachChild(node, child => classNames(child, into, side, ands));
    return into;
};

// A style={{ ... }} with literal colours: what the element really paints, where a class alone says
// otherwise (a button made transparent inline keeps the browser's grey here without it).
const inlineColours = (node) => {
    if (!node || !ts.isObjectLiteralExpression(node)) return '';
    const out = [];
    for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const name = ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? prop.name.text : null;
        if (!name || !/^(background|backgroundColor|backgroundImage|color)$/.test(name)) continue;
        if (!ts.isStringLiteralLike(prop.initializer)) continue;
        out.push(`${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}:${prop.initializer.text}`);
    }
    return out.join(';');
};

// The classes with no modifier on: every && off, and a ternary on its last arm, since one of its
// arms is always there (a card is always red or black; reading it as neither read white on white).
const steadyClassNames = node => classNames(node, [], 'second', false);

const words = list => list.join(' ').split(/\s+/).filter(word => /^[a-zA-Z_][\w-]*$/.test(word));

const parseFile = (file, srcDir, components, all) => {
    const at = relative(srcDir, file).split(sep).join('/');
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    // JSX held in a local (`const body = (<div/>)`) or made by a local function (`renderRow()`), by
    // name, and the elements that name it in braces: read once the file is parsed.
    const locals = new Map();
    const naming = [];

    const toNode = (node) => {
        const open = ts.isJsxSelfClosingElement(node) ? node : node.openingElement;
        const tag = open.tagName.getText(source);
        const found = {
            tag, intrinsic: /^[a-z]/.test(tag), classes: [], steady: [], first: [], second: [], style: '',
            at: `${at}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
            kids: [], text: false,
        };
        for (const prop of open.attributes.properties) {
            if (!ts.isJsxAttribute(prop) || !prop.initializer) continue;
            const value = ts.isJsxExpression(prop.initializer) ? prop.initializer.expression : prop.initializer;
            if (prop.name.getText(source) === 'style') { found.style = inlineColours(value); continue; }
            if (prop.name.getText(source) !== 'className') continue;
            found.classes = words(classNames(value));
            found.steady = words(steadyClassNames(value));
            found.first = words(classNames(value, [], 'first'));
            found.second = words(classNames(value, [], 'second'));
        }
        const visit = (child) => {
            if (ts.isJsxText(child)) { if (child.text.trim()) found.text = true; return; }
            if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) { found.kids.push(toNode(child)); return; }
            if (ts.isJsxFragment(child)) { child.children.forEach(visit); return; }
            if (ts.isJsxExpression(child) && child.expression) {
                const text = child.expression.getText(source);
                if (text === 'children' || text === 'props.children') { found.kids.push({ slot: true }); return; }
                let jsx = false;
                const dive = (inner, portal = false) => {
                    if (ts.isJsxElement(inner) || ts.isJsxSelfClosingElement(inner)) {
                        jsx = true;
                        const kid = toNode(inner);
                        if (portal) kid.portal = true;
                        found.kids.push(kid);
                        return;
                    }
                    if (ts.isJsxFragment(inner)) {
                        jsx = true;
                        const from = found.kids.length;
                        inner.children.forEach(visit);
                        if (portal) found.kids.slice(from).forEach((kid) => { kid.portal = true; });
                        return;
                    }
                    ts.forEachChild(inner, next => dive(next, portal || isPortal(inner)));
                };
                dive(child.expression);
                if (!jsx) {
                    const names = [];
                    let literal = false;
                    const named = (inner) => {
                        if (ts.isIdentifier(inner)) names.push(inner.text);
                        else if (ts.isStringLiteralLike(inner) || ts.isTemplateExpression(inner) || ts.isNumericLiteral(inner)) literal = true;
                        else if (ts.isPropertyAccessExpression(inner)) named(inner.expression);
                        else ts.forEachChild(inner, named);
                    };
                    named(child.expression);
                    naming.push([found, names, literal]);
                }
            }
        };
        if (ts.isJsxElement(node)) node.children.forEach(visit);
        for (const kid of found.kids) kid.parent = found;
        all.push(found);
        return found;
    };
    // JSX handed to createPortal is drawn on the page's body, not where its component is used.
    const isPortal = node => ts.isCallExpression(node) && /(^|\.)createPortal$/.test(node.expression.getText(source));

    const nameOf = (node) => {
        if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
            && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer) || ts.isCallExpression(node.initializer))) return node.name.text;
        return null;
    };
    // `host`: the component a root is drawn by, the nearest enclosing name that is one (JSX in a
    // useCallback or a render helper belongs to the component around it).
    const visit = (node, owner, host, portal, local) => {
        const own = nameOf(node);
        const name = own ?? owner;
        const drawnBy = own && /^[A-Z]/.test(own) ? own : host;
        const held = own ?? (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) ? node.name.text : local);
        if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
            const root = toNode(node);
            root.host = drawnBy;
            if (portal) root.portal = true;
            if (name) (components[name] ??= []).push(root);
            if (held) (locals.get(held) ?? locals.set(held, []).get(held)).push(root);
            return;
        }
        if (ts.isJsxFragment(node)) { node.children.forEach(child => visit(child, name, drawnBy, portal, held)); return; }
        ts.forEachChild(node, child => visit(child, name, drawnBy, portal || isPortal(node), held));
    };
    visit(source, null, null, false, null);
    // `{body}` or `{renderRow(x)}` is that JSX drawn there: it is drawn inside each element of the
    // same component that names it (never one inside it), and the first is where its own place is
    // read from. Braces with words in them (`{busy ? 'Saving' : body}`), or naming nothing held,
    // are words.
    const within = (node, root) => { for (let n = node; n; n = n.parent) if (n === root) return true; return false; };
    const hostOf = (node) => { let top = node; while (top.parent) top = top.parent; return top.host; };
    for (const [node, names, literal] of naming) {
        const host = hostOf(node);
        const roots = names.flatMap(name => locals.get(name) ?? []).filter(root => root.host === host);
        if (literal || !roots.length) node.text = true;
        for (const root of roots) {
            if (within(node, root)) continue;
            node.kids.push(root);
            root.parent ??= node;
        }
    }
};

export const readJsx = (srcDir) => {
    const components = {};
    const all = [];
    for (const file of walk(srcDir)) parseFile(file, srcDir, components, all);
    return { components, all };
};

// Where a root is drawn: for each of the first `most` places its component is used, the elements
// around it out to the page, outermost first, as { tag, classes } with the classes every instance
// has. A component used inside another's children gets that one's own elements around the slot,
// and what is handed to createPortal starts again at the page. A component nobody uses by name
// (lazy, or a helper's JSX outside any component) has one place: nothing around it.
//
// Without this a component was read on the chat's own paper, wherever it is drawn: the role
// editor's panels, dark on every theme, inside Light's Server Settings went unseen that way.
export const placesOf = ({ components, all }, { most = 3 } = {}) => {
    const sites = new Map();
    for (const node of all) if (!node.intrinsic) (sites.get(node.tag) ?? sites.set(node.tag, []).get(node.tag)).push(node);
    const wrapper = node => ({ tag: node.tag.toLowerCase(), classes: node.steady });
    const toSlot = (node, trail = new Set()) => {
        if (node.slot) return [];
        if (trail.has(node)) return null;
        const next = new Set(trail).add(node);
        for (const kid of node.kids ?? []) {
            const path = toSlot(kid, next);
            if (path) return [node, ...path];
        }
        return null;
    };
    // The elements a component puts around its children, and whether they are on the page's body.
    const aroundSlot = (name, seen) => {
        if (seen.has(name)) return null;
        const next = new Set(seen).add(name);
        for (const root of components[name] ?? []) {
            const path = toSlot(root);
            if (!path) continue;
            let wrappers = [];
            let portal = !!root.portal;
            for (const node of path) {
                if (node.portal) { wrappers = []; portal = true; }
                if (node.intrinsic) { wrappers.push(wrapper(node)); continue; }
                const inner = aroundSlot(node.tag, next);
                if (!inner) continue;
                if (inner.portal) { wrappers = []; portal = true; }
                wrappers.push(...inner.wrappers);
            }
            return { wrappers, portal };
        }
        return null;
    };
    // The elements around a place a component is used, inside the root it is in; and that root,
    // unless it is on the body.
    const around = (site, seen) => {
        const inner = [];
        for (let node = site; ; node = node.parent) {
            if (node.portal) return { inner, root: null };
            const up = node.parent;
            if (!up) return { inner, root: node };
            if (up.intrinsic) { inner.unshift(wrapper(up)); continue; }
            const slot = aroundSlot(up.tag, seen);
            if (!slot) continue;
            inner.unshift(...slot.wrappers);
            if (slot.portal) return { inner, root: null };
        }
    };
    const memo = new Map();
    const placesOfComponent = (name, seen) => {
        if (memo.has(name)) return memo.get(name);
        if (seen.has(name)) return [[]];
        const next = new Set(seen).add(name);
        const found = new Map();
        for (const site of sites.get(name) ?? []) {
            const { inner, root } = around(site, next);
            const outer = root?.host ? placesOfComponent(root.host, next)[0] : [];
            const place = [...outer, ...inner];
            found.set(place.map(w => `${w.tag}.${w.classes.join('.')}`).join(' '), place);
            if (found.size >= most) break;
        }
        const places = found.size ? [...found.values()] : [[]];
        memo.set(name, places);
        return places;
    };
    const placeOf = (root) => {
        if (root.portal) return [[]];
        // JSX held in a local is where it is named, inside its component's own elements.
        if (root.parent) {
            const { inner, root: top } = around(root, new Set());
            const outer = top?.host ? placesOfComponent(top.host, new Set()) : [[]];
            return outer.map(place => [...place, ...inner]);
        }
        return root.host ? placesOfComponent(root.host, new Set()) : [[]];
    };
    // What a component puts around the children it is given, for toHtml's `around`.
    placeOf.around = tag => aroundSlot(tag, new Set())?.wrappers ?? null;
    return placeOf;
};

// `html` inside the elements of a place. What the HTML parser would move or drop around other
// markup (a table's parts, SVG, a <p>) is a div with the same classes.
export const inPlace = (place, html) => {
    const tags = place.map(({ tag }) => (SKIP.has(tag) || /^(table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col|p|select|option)$/.test(tag) ? 'div' : tag));
    const open = place.map(({ classes }, i) => `<${tags[i]} class="${escape(classes.join(' '))}" data-place="1">`).join('');
    return `${open}${html}${tags.map(tag => `</${tag}>`).reverse().join('')}`;
};

const SKIP = new Set(['svg', 'path', 'circle', 'rect', 'g', 'line', 'polyline', 'polygon', 'video', 'audio', 'canvas', 'source', 'iframe', 'script', 'style', 'defs', 'stop', 'lineargradient', 'clippath', 'mask', 'ellipse', 'use', 'filter', 'img', 'br', 'hr', 'track']);
const escape = text => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// `steady`: only the classes every instance has. Otherwise every class any branch can give it, or
// with `arm` ('first' or 'second') one arm of each ternary. `around` (placesOf's): with components
// not inlined, what a component puts around the children it is handed still goes around them.
export const toHtml = (node, components, { steady = false, arm = null, around = null, depth = 0, seen = new Set(), slot = '', trail = new Set() } = {}) => {
    if (node.slot) return slot;
    // JSX held in a local can be named inside itself by way of another; each is drawn once on a path.
    if (trail.has(node)) return '';
    const on = new Set(trail).add(node);
    const inner = (extra = {}) => node.kids.map(kid => toHtml(kid, components, { steady, arm, around, depth, seen, slot, trail: on, ...extra })).join('');
    if (!node.intrinsic) {
        if (/Icon$/.test(node.tag)) return '<span data-icon="1" style="display:inline-block;width:16px;height:16px;background:currentColor"></span>';
        const known = components[node.tag];
        if (!known || seen.has(node.tag) || depth > 14) {
            const given = inner();
            const wrappers = given && around ? around(node.tag) : null;
            return wrappers?.length ? inPlace(wrappers, given) : given;
        }
        const next = new Set(seen).add(node.tag);
        const given = inner();
        return known.map(root => toHtml(root, components, { steady, arm, around, depth: depth + 1, seen: next, slot: given })).join('') || given;
    }
    const tag = node.tag.toLowerCase();
    if (SKIP.has(tag)) return '';
    const classes = steady ? node.steady : arm ? node[arm] : node.classes;
    const attrs = ` class="${escape(classes.join(' '))}" data-at="${escape(node.at)}"${node.style ? ` style="${escape(node.style)}"` : ''}`;
    if (tag === 'input') return `<input${attrs} data-text="1" value="Sample" placeholder="Sample">`;
    if (tag === 'textarea') return `<textarea${attrs} data-text="1" placeholder="Sample">Sample</textarea>`;
    if (tag === 'select') return `<select${attrs} data-text="1"><option>Sample</option></select>`;
    const words = node.text ? 'Sample ' : '';
    return `<${tag}${attrs}${node.text ? ' data-text="1"' : ''}>${words}${inner()}</${tag}>`;
};
