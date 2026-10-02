#!/usr/bin/env python3
"""Fail when one SQL text is bound with different types by different call sites.

WHY. sqlx caches a prepared statement per connection, keyed by the SQL text
ALONE. Two call sites that run the same text but bind, say, i32 and i64 at the
same parameter share one statement on a pooled connection: whichever runs
second sends its width into the other's declared parameter type, and Postgres
answers 22P03 "incorrect binary data format in bind parameter N" (an i64 into
INT4) or 08P01 "insufficient data left in message" (an i32 into INT8). It is
intermittent by construction - it depends on which connection serves the
request and who prepared the text on it first - so no ordinary test sees it.
It has shipped three times: the cold-boot device-token 500 (2026-08-20), the
SFU join "Channel not found" after a channel edit, and the task-events viewer
lookup that silently dropped live Tasks updates (both found 2026-10-02).
The rule: every user of a shared SQL text binds the COLUMN's width.

HOW. Reading a bind's type off the source is how this got past review three
times (`channel_id` was i64 in one handler and i32 in the next), so this asks
the compiler. In a temporary copy of the crate (the working tree is never
touched) every `.bind(EXPR)` becomes `.bind({ let __bw_t_N: () = EXPR; __bw_t_N })`;
one `cargo check --tests` then reports E0308 "expected `()`, found `T`" for
each, i.e. the exact type of every bound argument. Call sites are grouped by
their runtime SQL text (string literals with `\\` continuations, consts,
concat!, format! over consts only, `let sql = format!(...)` in the same fn, a
const array looped over, a const passed through a helper's parameter), and
every text bound with two Postgres types at one position is reported.

SELF-CHECK. Every run plants a known i32-vs-i64 pair in the temporary copy
and fails (exit 2) unless that pair is reported - a check that can no longer
see a collision must not pass. It also fails if rustc typed too few binds.

RUNTIME-BUILT SQL that cannot be resolved to a text is checked by hand: the
production sites below are listed with the reason they cannot collide, and a
NEW one fails this check until someone does the same and adds it here.

Usage:  python3 scripts/check-sql-bind-types.py [--keep-temp]
Exit:   0 clean, 1 mismatches or an unreviewed runtime-built query, 2 the check itself is broken.
Env:    CARGO_TARGET_DIR (default: target/sql-bind-check) - reused between runs.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Production queries whose SQL is built at runtime from conditional pieces, so
# no single text can be resolved statically. Each was reviewed by hand; the
# reason says why it cannot share a text with a site that binds differently.
# (file, enclosing fn) -> reason. Test-module sites are not listed (or checked).
REVIEWED_RUNTIME_SQL = {
    ('src/handlers.rs', 'update_profile'):
        'UPDATE users SET <avatar/display_name/dms/online/idle/sounds> WHERE id = $N; '
        'no other site builds these field sets; id bound as i32 (users.id INT4)',
    ('src/server_handlers.rs', 'update_profile'):
        'UPDATE users SET <status/custom_status/bio> WHERE id = $N; field set disjoint '
        'from handlers::update_profile, so the texts never coincide',
    ('src/task_handlers.rs', 'update_task'):
        'two builders (the edit and the why/snooze clause) over channel_tasks; texts '
        'built only here, every id bound i64 (BIGINT columns)',
    ('src/task_handlers.rs', 'move_task'):
        'neighbour lookup over channel_tasks built only here; ids bound i64 (BIGINT)',
    ('src/task_handlers.rs', 'list_task_lists'):
        'task_lists listing built only here; owner bound i64 (task_lists BIGINT)',
}

CALL = re.compile(r'sqlx::(query_as_with|query_scalar_with|query_with|query_as|query_scalar|query)\b\s*(::\s*<)?')
TERMINALS = ('fetch_one', 'fetch_optional', 'fetch_all', 'fetch', 'execute', 'fetch_many')
CONTROL_TEXT = 'SELECT $1::int8 IS NOT NULL /* check-sql-bind-types positive control */'
CONTROL_MODULE = '''

#[cfg(test)]
#[allow(dead_code)]
mod __check_sql_bind_types_control {
    async fn binds_i32(pool: &sqlx::PgPool) {
        let _ = sqlx::query("%s").bind(1_i32).execute(pool).await;
    }
    async fn binds_i64(pool: &sqlx::PgPool) {
        let _ = sqlx::query("%s").bind(1_i64).execute(pool).await;
    }
}
''' % (CONTROL_TEXT, CONTROL_TEXT)


# ---------------------------------------------------------------- Rust parsing

def skip_generics(s, i):
    depth = 1
    while depth:
        if s[i] == '<':
            depth += 1
        elif s[i] == '>':
            depth -= 1
        i += 1
    return i


def read_string(s, i):
    """A Rust string literal at s[i] -> (runtime value, index after it)."""
    m = re.match(r'r(#*)"', s[i:i + 10])
    if m:
        hashes = m.group(1)
        start = i + len(m.group(0))
        end = s.index('"' + hashes, start)
        return s[start:end].replace('\r\n', '\n'), end + 1 + len(hashes)
    if s[i] != '"':
        raise ValueError('not a string literal: ' + s[i:i + 20])
    out, j = [], i + 1
    while True:
        c = s[j]
        if c == '"':
            return ''.join(out), j + 1
        if c == '\\':
            n = s[j + 1]
            if n == '\n' or (n == '\r' and s[j + 2] == '\n'):
                j += 2 if n == '\n' else 3
                while s[j] in ' \t\r\n':
                    j += 1
                continue
            esc = {'n': '\n', 't': '\t', 'r': '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'"}
            if n in esc:
                out.append(esc[n])
                j += 2
                continue
            if n == 'x':
                out.append(chr(int(s[j + 2:j + 4], 16)))
                j += 4
                continue
            if n == 'u':
                k = s.index('}', j)
                out.append(chr(int(s[j + 3:k], 16)))
                j = k + 1
                continue
            raise ValueError('escape ' + s[j:j + 5])
        if c == '\r' and s[j + 1] == '\n':
            j += 1
            continue
        out.append(c)
        j += 1


TOKEN_CHAR = re.compile(r"b?'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|.)|[^'\\\n])'")


def skip_token(s, j):
    """If s[j] starts a comment, string or char literal, the index just past it; else None."""
    c = s[j]
    if c == '/' and s.startswith('//', j):
        nl = s.find('\n', j)
        return len(s) if nl < 0 else nl
    if c == '/' and s.startswith('/*', j):
        depth, k = 0, j
        while k < len(s):
            if s.startswith('/*', k):
                depth += 1
                k += 2
            elif s.startswith('*/', k):
                depth -= 1
                k += 2
                if depth == 0:
                    return k
            else:
                k += 1
        return len(s)
    if c in 'brc"\'' and not (j > 0 and (s[j - 1].isalnum() or s[j - 1] == '_')) or c in '"\'':
        m = re.match(r'(?:b|c)?r(#*)"', s[j:j + 12])
        if m:
            end = s.index('"' + m.group(1), j + len(m.group(0)))
            return end + 1 + len(m.group(1))
        m = re.match(r'(?:b|c)?"', s[j:j + 2])
        if m:
            _, k = read_string(s, j + len(m.group(0)) - 1)
            return k
        m = TOKEN_CHAR.match(s, j)
        if m:
            return m.end()
    return None


def read_balanced(s, i, open_c='(', close_c=')'):
    depth, j = 0, i
    while True:
        k = skip_token(s, j)
        if k is not None:
            j = k
            continue
        c = s[j]
        if c == open_c:
            depth += 1
        elif c == close_c:
            depth -= 1
            if depth == 0:
                return s[i + 1:j], j + 1
        j += 1


def test_regions(s):
    """[(start, end)] of every item carrying #[cfg(test)] (a module, fn, impl, ...),
    found by a scan that skips strings and comments - test fixtures in this repo
    hold fake Rust source, attributes and braces included, inside raw strings."""
    out, j = [], 0
    attr = re.compile(r'#\[cfg\(\s*test\s*\)\]')
    while j < len(s):
        k = skip_token(s, j)
        if k is not None:
            j = k
            continue
        m = attr.match(s, j)
        if not m:
            j += 1
            continue
        start, q = j, m.end()
        # further attributes, then the item; it ends at its first top-level `;`
        # or at the brace that closes its first top-level `{`.
        depth = 0
        while q < len(s):
            k = skip_token(s, q)
            if k is not None:
                q = k
                continue
            c = s[q]
            if c in '([':
                depth += 1
            elif c in ')]':
                depth -= 1
            elif depth == 0 and c == ';':
                q += 1
                break
            elif depth == 0 and c == '{':
                _, q = read_balanced(s, q, '{', '}')
                break
            q += 1
        out.append((start, q))
        j = q
    return out


def concat_literals(inner):
    parts, k = [], 0
    while k < len(inner):
        if inner[k] in ' \t\r\n,':
            k += 1
            continue
        v, k = read_string(inner, k)
        parts.append(v)
    return ''.join(parts)


def sql_text(arg, consts):
    """(kind, runtime text) of a query's SQL argument; kind 'dynamic' if it depends on runtime values."""
    a = arg.strip()
    while a.startswith('//'):
        nl = a.find('\n')
        a = '' if nl < 0 else a[nl + 1:].strip()
    if a.endswith(','):
        a = a[:-1].rstrip()
    a2 = a[1:].strip() if a.startswith('&') else a
    mpath = re.fullmatch(r'(?:[a-z_][a-z0-9_]*::)+([A-Z_][A-Z0-9_]*)', a2)
    if mpath and mpath.group(1) in consts:
        return 'const', consts[mpath.group(1)]
    if a2.startswith('"') or re.match(r'r#*"', a2):
        val, end = read_string(a2, 0)
        return ('literal', val) if not a2[end:].strip() else ('dynamic', a)
    if re.match(r'concat!\s*\(', a2):
        inner, _ = read_balanced(a2, a2.index('('))
        return 'literal', concat_literals(inner)
    if re.fullmatch(r'[A-Z_][A-Z0-9_]*', a2) and a2 in consts:
        return 'const', consts[a2]
    if re.match(r'format!\s*\(', a2):
        inner, end = read_balanced(a2, a2.index('('))
        inner = inner.strip()
        if a2[end:].strip() or not (inner.startswith('"') or re.match(r'r#*"', inner)):
            return 'dynamic', a
        tmpl, k = read_string(inner, 0)
        if inner[k:].strip().strip(','):
            return 'dynamic', a
        bare = tmpl.replace('{{', '').replace('}}', '')
        if re.search(r'\{[^}]*[:?][^}]*\}', bare):
            return 'dynamic', a
        names = re.findall(r'\{([A-Za-z_][A-Za-z0-9_]*)\}', bare)
        if any(n not in consts for n in names):
            return 'dynamic', a
        out = re.sub(r'(?<!\{)\{([A-Za-z_][A-Za-z0-9_]*)\}', lambda mm: consts[mm.group(1)], tmpl)
        return 'format', out.replace('{{', '{').replace('}}', '}')
    return 'dynamic', a


def fn_start_before(s, i):
    return max((m.start() for m in re.finditer(r'\bfn\s+[a-zA-Z_]', s[:i])), default=0)


def fn_name_at(s, i):
    ms = list(re.finditer(r'\bfn\s+([a-zA-Z_][a-zA-Z0-9_]*)', s[:i]))
    return ms[-1].group(1) if ms else '?'


def resolve_local(s, pos, arg, consts):
    """`&sql`: the `let sql = <literal|format!|concat!>` earlier in the same fn."""
    a = arg.strip().rstrip(',').strip().lstrip('&').strip()
    if not re.fullmatch(r'[a-z_][a-z0-9_]*', a):
        return None
    body = s[fn_start_before(s, pos):pos]
    lets = list(re.finditer(r'\blet\s+(?:mut\s+)?' + re.escape(a) + r'\s*(?::\s*[^=]+)?=\s*', body))
    if not lets:
        return None
    k = j = lets[-1].end()
    depth = 0
    while j < len(body):
        c = body[j]
        if c == '"' or (c == 'r' and re.match(r'r#*"', body[j:j + 10])):
            _, j = read_string(body, j)
            continue
        if c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
        elif c == ';' and depth == 0:
            break
        j += 1
    kind, text = sql_text(body[k:j], consts)
    return None if kind == 'dynamic' else ('local-' + kind, text)


def collect_consts(files):
    consts, arrays = {}, {}
    scalar = re.compile(r"const\s+([A-Z_][A-Z0-9_]*)\s*:\s*&(?:'static\s+)?str\s*=\s*")
    array = re.compile(r"const\s+([A-Z_][A-Z0-9_]*)\s*:\s*&(?:'static\s+)?\[\s*&(?:'static\s+)?str\s*\]\s*=\s*&\[")
    for s in files.values():
        for m in scalar.finditer(s):
            k = m.end()
            try:
                if s[k] == '"' or re.match(r'r#*"', s[k:k + 10]):
                    consts[m.group(1)], _ = read_string(s, k)
                elif s.startswith('concat!', k):
                    inner, _ = read_balanced(s, s.index('(', k))
                    consts[m.group(1)] = concat_literals(inner)
            except (ValueError, IndexError):
                pass
        for m in array.finditer(s):
            inner, _ = read_balanced(s, m.end() - 1, '[', ']')
            items, q = [], 0
            while q < len(inner):
                if inner[q] in ' \t\r\n,':
                    q += 1
                elif inner.startswith('//', q):
                    q = inner.index('\n', q)
                elif inner[q] == '"' or re.match(r'r#*"', inner[q:q + 10]):
                    v, q = read_string(inner, q)
                    items.append(v)
                elif inner.startswith('concat!', q):
                    sub, q = read_balanced(inner, inner.index('(', q))
                    items.append(concat_literals(sub))
                else:
                    q += 1
            arrays[m.group(1)] = items
    return consts, arrays


def bind_spans(s, i):
    out, j = [], i
    while True:
        m = re.match(r'\s*(//[^\n]*\n\s*)*\.\s*([a-z_]+)\s*(::\s*<[^>]*>)?\s*\(', s[j:])
        if not m:
            return out
        k = j + m.end() - 1
        _, after = read_balanced(s, k)
        if m.group(2) == 'bind':
            a, b = k + 1, after - 1
            while s[a].isspace():
                a += 1
            while s[b - 1].isspace():
                b -= 1
            out.append((s[a:b], a, b))
        elif m.group(2) in TERMINALS:
            return out
        j = after


# --------------------------------------------------------------------- the check

def pg_type(t):
    """What Postgres sees: references, Option and literal fallback do not change the parameter type."""
    t = (t or '?').replace('&mut ', '').replace('&', '').strip()
    t = re.sub(r"'\w+ ", '', t)
    while re.fullmatch(r'Option<(.*)>', t):
        t = re.fullmatch(r'Option<(.*)>', t).group(1)
    t = {'integer': 'i32', 'floating-point number': 'f64', 'String': 'TEXT', 'str': 'TEXT',
         'Vec<u8>': 'BYTEA', '[u8]': 'BYTEA'}.get(t, t)
    if re.fullmatch(r'\[u8; \d+\]', t):
        t = 'BYTEA'
    m = re.fullmatch(r'Vec<(.*)>', t)
    if m and pg_type(m.group(1)) == 'TEXT':
        t = 'TEXT[]'
    return t


def main():
    keep = '--keep-temp' in sys.argv
    files = {}
    for dp, _, names in os.walk(os.path.join(ROOT, 'src')):
        for f in names:
            if f.endswith('.rs'):
                p = os.path.join(dp, f)
                with open(p, encoding='utf-8', newline='') as fh:
                    files[os.path.relpath(p, ROOT).replace('\\', '/')] = fh.read()
    if 'src/main.rs' not in files:
        print('check-sql-bind-types: src/main.rs not found', file=sys.stderr)
        return 2
    files['src/main.rs'] += CONTROL_MODULE          # the positive control, temp copy only
    consts, arrays = collect_consts({k: v.replace('\r\n', '\n') for k, v in files.items()})

    sites, rewrites, n = [], {}, 0
    for path, s in files.items():
        # Exactly the brace span of each `#[cfg(test)] mod x { ... }` - not
        # "everything after the first one": production code after a test
        # module must still be checked.
        test_spans = test_regions(s)
        for m in CALL.finditer(s):
            i = skip_generics(s, m.end()) if m.group(2) else m.end()
            while s[i].isspace():
                i += 1
            if s[i] != '(':
                continue
            arg, after = read_balanced(s, i)
            kind, text = sql_text(arg.replace('\r\n', '\n'), consts)
            if kind == 'dynamic':
                kind, text = resolve_local(s, m.start(), arg, consts) or (kind, text)
            site = {'file': path, 'line': s.count('\n', 0, m.start()) + 1, 'fn': fn_name_at(s, m.start()),
                    'kind': kind, 'text': text, 'arg': ' '.join(arg.split()),
                    'test': any(a <= m.start() < b for a, b in test_spans), 'pos': m.start(), 'binds': []}
            for expr, a, b in bind_spans(s, after):
                n += 1
                site['binds'].append({'id': n, 'expr': ' '.join(expr.split())})
                rewrites.setdefault(path, []).append((a, b, '{ let __bw_t_%d: () = %s; __bw_t_%d }' % (n, s[a:b], n)))
            sites.append(site)

    # Texts reaching sqlx through a loop over a const array, or a helper's parameter.
    extra = []
    for site in sites:
        if site['kind'] != 'dynamic':
            continue
        s = files[site['file']]
        a = site['arg'].lstrip('*&').strip()
        if not re.fullmatch(r'[a-z_][a-z0-9_]*', a):
            continue
        start = fn_start_before(s, site['pos'])
        loop = re.findall(r'\bfor\s+' + re.escape(a) + r'\s+in\s+(?:&\s*)?([A-Z_][A-Z0-9_]*)', s[start:site['pos']])
        if loop and loop[-1] in arrays:
            site['kind'] = 'loop'
            extra += [dict(site, kind='array ' + loop[-1], text=t) for t in arrays[loop[-1]]]
            continue
        sig = re.match(r'(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-z_][a-z0-9_]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)', s[start:])
        if not sig:
            continue
        params = [p.split(':')[0].replace('mut ', '').strip() for p in sig.group(2).split(',') if ':' in p]
        if a not in params:
            continue
        idx, helper = params.index(a), sig.group(1)
        for p2, s2 in files.items():
            for cm in re.finditer(r'\b' + helper + r'\s*\(', s2):
                if s2[:cm.start()].rstrip().endswith('fn'):
                    continue
                inner, _ = read_balanced(s2, cm.end() - 1)
                args = [x.strip() for x in re.split(r',(?![^()]*\))', inner)]
                if idx < len(args) and args[idx] in consts:
                    site['kind'] = 'helper'
                    extra.append(dict(site, kind='via ' + helper + '(' + args[idx] + ')', text=consts[args[idx]],
                                      file=p2, line=s2.count('\n', 0, cm.start()) + 1, fn=fn_name_at(s2, cm.start())))

    # ---- one cargo check over a probed temp copy ----
    tmp = tempfile.mkdtemp(prefix='sql-bind-check-')
    skip = {'.git', 'target', 'node_modules', 'dist', 'dist-desktop', '.gradle', 'build', 'android', 'ios', 'src-tauri'}
    try:
        for item in os.listdir(ROOT):
            if item in skip:
                continue
            src = os.path.join(ROOT, item)
            if os.path.isdir(src):
                shutil.copytree(src, os.path.join(tmp, item), ignore=lambda d, names: [x for x in names if x in skip])
            else:
                shutil.copy2(src, os.path.join(tmp, item))
        for path, rw in rewrites.items():
            s = files[path]
            for a, b, new in sorted(rw, key=lambda x: -x[0]):
                s = s[:a] + new + s[b:]
            with open(os.path.join(tmp, path), 'w', encoding='utf-8', newline='') as fh:
                fh.write(s)
        env = dict(os.environ)
        env.setdefault('CARGO_TARGET_DIR', os.path.join(ROOT, 'target', 'sql-bind-check'))
        r = subprocess.run(['cargo', 'check', '--tests', '--message-format=json'], cwd=tmp, env=env,
                           capture_output=True, text=True, encoding='utf-8', errors='replace')
    finally:
        if keep:
            print('temp copy kept at', tmp)
        else:
            shutil.rmtree(tmp, ignore_errors=True)

    types = {}
    for line in r.stdout.splitlines():
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get('reason') != 'compiler-message':
            continue
        msg = msg['message']
        if (msg.get('code') or {}).get('code') != 'E0308':
            continue
        for sp in msg['spans']:
            mm = re.search(r'expected `\(\)`, found (.*)$', sp.get('label') or '')
            if not sp.get('is_primary') or not mm or not sp.get('text'):
                continue
            t0 = sp['text'][0]
            hid = re.findall(r'__bw_t_(\d+): \(\) = $', t0['text'][:t0['highlight_start'] - 1])
            if hid:
                types[int(hid[-1])] = mm.group(1).strip().strip('`')
    for site in sites:
        for b in site['binds']:
            b['type'] = types.get(b['id'])

    # ---- the check can fail, or it proves nothing ----
    if n == 0 or len(types) < 0.97 * n:
        print(f'check-sql-bind-types: BROKEN - rustc typed {len(types)} of {n} binds '
              f'(cargo exit {r.returncode}); the probe no longer reads the compiler.', file=sys.stderr)
        tail = [l for l in r.stderr.splitlines() if l.strip()][-15:]
        print('\n'.join(tail), file=sys.stderr)
        return 2

    groups = {}
    for x in sites + extra:
        if x['kind'] not in ('dynamic', 'loop', 'helper'):
            groups.setdefault(x['text'], []).append(x)
    found = []
    for text, g in groups.items():
        if len(g) < 2:
            continue
        for pos in range(max(len(x['binds']) for x in g)):
            by = {}
            for x in g:
                if pos < len(x['binds']) and x['binds'][pos]['type']:
                    by.setdefault(pg_type(x['binds'][pos]['type']), []).append(x)
            if len(by) > 1:
                found.append((text, pos, by))

    control = [f for f in found if f[0] == CONTROL_TEXT]
    if len(control) != 1 or set(control[0][2]) != {'i32', 'i64'}:
        print('check-sql-bind-types: BROKEN - the planted i32/i64 pair was not reported; '
              'this check can no longer see a collision.', file=sys.stderr)
        return 2
    found = [f for f in found if f[0] != CONTROL_TEXT]

    unreviewed = [x for x in sites if x['kind'] == 'dynamic' and not x['test']
                  and (x['file'], x['fn']) not in REVIEWED_RUNTIME_SQL]
    stale = [k for k in REVIEWED_RUNTIME_SQL
             if not any(x['kind'] == 'dynamic' and (x['file'], x['fn']) == k for x in sites)]

    resolved = sum(1 for x in sites if x['kind'] != 'dynamic')
    shared = sum(1 for g in groups.values() if len(g) > 1)
    print(f'check-sql-bind-types: {len(sites)} query call sites ({resolved} with a known SQL text), '
          f'{len(types)}/{n} binds typed by rustc, {shared} SQL texts shared by 2+ sites; positive control seen.')
    rc = 0
    for text, pos, by in found:
        rc = 1
        print(f'\nMISMATCH at ${pos + 1} of: {" ".join(text.split())[:160]}')
        for t, xs in sorted(by.items()):
            for x in xs:
                tag = ' [test]' if x['test'] else ''
                print(f'  {t:<10} {x["file"]}:{x["line"]} ({x["fn"]}){tag}  .bind({x["binds"][pos]["expr"]}) : {x["binds"][pos]["type"]}')
    if found:
        print('\nBind the COLUMN\'s width at every site of a shared text (i32 for INT4, i64 for BIGINT).')
    for x in unreviewed:
        rc = 1
        print(f'\nUNREVIEWED runtime-built SQL: {x["file"]}:{x["line"]} ({x["fn"]}) query({x["arg"][:80]})\n'
              f'  Its text cannot be resolved statically. Check that no other site can produce the same text\n'
              f'  with different bind types, then add ({x["file"]!r}, {x["fn"]!r}) to REVIEWED_RUNTIME_SQL with the reason.')
    for k in stale:
        print(f'note: REVIEWED_RUNTIME_SQL entry {k} no longer matches a runtime-built query; remove it.')
    if rc == 0:
        print('OK: every shared SQL text is bound with one type per parameter.')
    return rc


if __name__ == '__main__':
    sys.exit(main())
