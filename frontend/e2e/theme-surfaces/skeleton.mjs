// The app's JSX as markup, read from the source, for measuring colours under the real stylesheet.
//
// A colour is decided by which classes sit inside which, and those live in the source. So this does
// not copy any markup into a fixture, where it could go stale: it parses every .tsx (TypeScript's own
// parser) and renders an element's JSX subtree as plain HTML, with the components it uses inlined and
// `{children}` filled in from the call site. Text becomes "Sample", an icon a small currentColor box.
// Nothing runs, so a surface inline in a 7000-line component costs the same as a small one, and a
// branch no fixture would reach is still measured.
//
// What this cannot see is a class computed in a helper function, and a colour set from JavaScript.
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

const classNames = (node, into = []) => {
    if (!node) return into;
    if (ts.isStringLiteralLike(node)) { into.push(node.text); return into; }
    if (ts.isTemplateExpression(node)) {
        into.push(node.head.text);
        for (const span of node.templateSpans) { classNames(span.expression, into); into.push(span.literal.text); }
        return into;
    }
    // The test of a ternary or an && names a value, not a class.
    if (ts.isConditionalExpression(node)) { classNames(node.whenTrue, into); classNames(node.whenFalse, into); return into; }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return classNames(node.right, into);
    ts.forEachChild(node, child => classNames(child, into));
    return into;
};

// The classes always there, for the reading with no modifier on.
const steadyClassNames = (node) => {
    if (!node) return [];
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isTemplateExpression(node)) return [node.head.text];
    return [];
};

const words = list => list.join(' ').split(/\s+/).filter(word => /^[a-zA-Z_][\w-]*$/.test(word));

const parseFile = (file, srcDir, components, all) => {
    const at = relative(srcDir, file).split(sep).join('/');
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    const toNode = (node) => {
        const open = ts.isJsxSelfClosingElement(node) ? node : node.openingElement;
        const tag = open.tagName.getText(source);
        const found = {
            tag, intrinsic: /^[a-z]/.test(tag), classes: [], steady: [],
            at: `${at}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
            kids: [], text: false,
        };
        for (const prop of open.attributes.properties) {
            if (!ts.isJsxAttribute(prop) || !prop.initializer) continue;
            if (prop.name.getText(source) !== 'className') continue;
            const value = ts.isJsxExpression(prop.initializer) ? prop.initializer.expression : prop.initializer;
            found.classes = words(classNames(value));
            found.steady = words(steadyClassNames(value));
        }
        const visit = (child) => {
            if (ts.isJsxText(child)) { if (child.text.trim()) found.text = true; return; }
            if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) { found.kids.push(toNode(child)); return; }
            if (ts.isJsxFragment(child)) { child.children.forEach(visit); return; }
            if (ts.isJsxExpression(child) && child.expression) {
                const text = child.expression.getText(source);
                if (text === 'children' || text === 'props.children') { found.kids.push({ slot: true }); return; }
                let jsx = false;
                const dive = (inner) => {
                    if (ts.isJsxElement(inner) || ts.isJsxSelfClosingElement(inner)) { jsx = true; found.kids.push(toNode(inner)); return; }
                    if (ts.isJsxFragment(inner)) { jsx = true; inner.children.forEach(visit); return; }
                    ts.forEachChild(inner, dive);
                };
                dive(child.expression);
                if (!jsx) found.text = true;
            }
        };
        if (ts.isJsxElement(node)) node.children.forEach(visit);
        all.push(found);
        return found;
    };

    const nameOf = (node) => {
        if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
            && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer) || ts.isCallExpression(node.initializer))) return node.name.text;
        return null;
    };
    const visit = (node, owner) => {
        const name = nameOf(node) ?? owner;
        if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
            const root = toNode(node);
            if (name) (components[name] ??= []).push(root);
            return;
        }
        if (ts.isJsxFragment(node)) { node.children.forEach(child => visit(child, name)); return; }
        ts.forEachChild(node, child => visit(child, name));
    };
    visit(source, null);
};

export const readJsx = (srcDir) => {
    const components = {};
    const all = [];
    for (const file of walk(srcDir)) parseFile(file, srcDir, components, all);
    return { components, all };
};

const SKIP = new Set(['svg', 'path', 'circle', 'rect', 'g', 'line', 'polyline', 'polygon', 'video', 'audio', 'canvas', 'source', 'iframe', 'script', 'style', 'defs', 'stop', 'lineargradient', 'clippath', 'mask', 'ellipse', 'use', 'filter', 'img', 'br', 'hr', 'track']);
const escape = text => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// `steady`: only the classes every instance has. Otherwise every class any branch can give it.
export const toHtml = (node, components, { steady = false, depth = 0, seen = new Set(), slot = '' } = {}) => {
    if (node.slot) return slot;
    const inner = (extra = {}) => node.kids.map(kid => toHtml(kid, components, { steady, depth, seen, slot, ...extra })).join('');
    if (!node.intrinsic) {
        if (/Icon$/.test(node.tag)) return '<span data-icon="1" style="display:inline-block;width:16px;height:16px;background:currentColor"></span>';
        const known = components[node.tag];
        if (!known || seen.has(node.tag) || depth > 14) return inner();
        const next = new Set(seen).add(node.tag);
        const given = inner();
        return known.map(root => toHtml(root, components, { steady, depth: depth + 1, seen: next, slot: given })).join('') || given;
    }
    const tag = node.tag.toLowerCase();
    if (SKIP.has(tag)) return '';
    const classes = steady ? node.steady : node.classes;
    const attrs = ` class="${escape(classes.join(' '))}" data-at="${escape(node.at)}"`;
    if (tag === 'input') return `<input${attrs} data-text="1" value="Sample" placeholder="Sample">`;
    if (tag === 'textarea') return `<textarea${attrs} data-text="1" placeholder="Sample">Sample</textarea>`;
    if (tag === 'select') return `<select${attrs} data-text="1"><option>Sample</option></select>`;
    const words = node.text ? 'Sample ' : '';
    return `<${tag}${attrs}${node.text ? ' data-text="1"' : ''}>${words}${inner()}</${tag}>`;
};
