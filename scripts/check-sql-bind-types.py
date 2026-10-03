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
touched) every bound argument becomes `crate::__bw_probe::<N, _, _>(EXPR)`, an
identity fn whose trait bound has two blanket impls. rustc cannot pick one, and
it reports that ambiguity (E0283) only AFTER inference and integer fallback, as
"multiple impls satisfying `T: __BwProbe<N, _>`": the type sqlx really encodes,
for any expression shape (if/else, blocks, vec!, format!, a literal whose width
is fixed later in the fn). `cargo check --tests`, repeated over the binds a
pass left untyped (rustc drops a fn's ambiguities when another error fired
while it was being checked; 3 passes on this crate), types every bind.

WHAT IS A SITE. `sqlx::query*(..)` and `query*(..)` imported from sqlx, with
the `.bind()` calls chained onto it (comments between them are skipped), and
every `QueryBuilder::new`. A site's SQL text is resolved statically from: string
literals (`\\` continuations included), consts (resolved by module path and
scope - a name defined twice with different values is refused, not guessed),
concat!, format! whose pieces resolve, a local `let` in the same fn (including
`if .. { A } else { B }`, which yields both texts), a const array looped over,
and a helper's SQL parameter (one text per resolvable call). Sites are grouped
by text; any text bound with two Postgres types at one position fails.

IT FAILS (exit 1) ON
- a text bound with two types at one parameter (MISMATCH);
- a known text whose highest `$N` differs from the number of binds it can see,
  i.e. binds added out of its sight (reassignment `q = q.bind(..)`, a helper
  that takes the Query, ...) (BINDS NOT VISIBLE);
- a bind on a shared text that rustc did not type (UNTYPED);
- a const name it cannot resolve to one value (AMBIGUOUS CONST);
- production SQL built at runtime that is not in REVIEWED_RUNTIME_SQL, or a fn
  whose number of runtime-built queries no longer matches its entry
  (UNREVIEWED). Each entry declares the texts its builders can emit (a regex)
  and their parameter types, and every static site whose text one of them could
  emit is compared with it like any other site.

SELF-CHECK (exit 2). Every run plants a known pair in the temporary copy - an
i32 site against an i64 one whose width is only fixed AFTER the bind, in a fn
that also probes another bind - and exits 2 unless exactly that pair is
reported. It also exits 2 when the probed copy has any compiler error other
than the probes (an error elsewhere in a fn hides that fn's probes), when rustc
typed too few binds, or on any internal error.

NOT COVERED. tests/ (separate crates), code cfg'd out on the platform running
the check (its binds are untyped - fatal only on a shared text), a Query value
built in one fn and run with a text from another (caught only by the `$N`
count when the text is known), and SQL text passed through more than one
level of helper parameters (reported as UNREVIEWED in production code, ignored
in test code). Test-only code is grouped and compared like production, but a
runtime-built test query needs no review entry.

Usage:  python3 scripts/check-sql-bind-types.py [--keep-temp] [--dump-sites FILE]
Exit:   0 clean, 1 a finding above, 2 the check itself is broken.
Env:    CARGO_TARGET_DIR (default: target/sql-bind-check) - reused between runs.
"""
import itertools
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_COLS_PROFILE = r'(?:avatar_file_id|display_name|allow_dms_from_server_members|show_online_status|show_idle_status|join_sound_file_id|leave_sound_file_id)'
_COLS_STATUS = r'(?:status|custom_status|bio)'
_COLS_ROLE = r'(?:name|color|permissions|position)'
_COLS_SERVER = (r'(?:clips_enabled|games_enabled|clip_max_seconds|clip_channel_id|name|is_public|require_media_e2ee|'
                r'afk_timeout_minutes|description|icon_file_id)')


def _set_list(cols):
    return cols + r' = \$\d+(?:, ' + cols + r' = \$\d+)*'


# Production queries whose SQL is built at runtime from conditional pieces, so
# no single text can be resolved statically. Each was reviewed by hand.
#   (file, enclosing fn) -> {'reason', 'builders': [one per runtime-built query
#   in that fn, in source order]}
# A builder declares the texts it can emit ('emits', a regex matched against
# the whole text) and its parameter types, either
#   'params': {column: Postgres type}  - for `column = $N` builders whose binds
#       are added out of the chain (reassignment, push_bind). Those binds are
#       probed too: a push_bind must have the type declared for the column
#       pushed just before it, any other one of the declared types, so the
#       entry cannot drift from the code silently.
#   'positional': True  - the builder's binds are chained onto the call, so
#       rustc types them like any other site's.
# Any static site whose text a builder could emit is compared with it.
REVIEWED_RUNTIME_SQL = {
    ('src/handlers.rs', 'update_profile'): {
        'reason': 'UPDATE users SET <the profile fields present> WHERE id = $N; users.id is INT4. '
                  'A static site running one of these texts (upload_handlers tests do, for the avatar) '
                  'is compared with these types.',
        'builders': [{
            'emits': r'UPDATE users SET ' + _set_list(_COLS_PROFILE) + r' WHERE id = \$\d+',
            'params': {'avatar_file_id': 'TEXT', 'display_name': 'TEXT', 'allow_dms_from_server_members': 'bool',
                       'show_online_status': 'bool', 'show_idle_status': 'bool',
                       'join_sound_file_id': 'TEXT', 'leave_sound_file_id': 'TEXT', 'id': 'i32'},
        }],
    },
    ('src/server_handlers.rs', 'update_profile'): {
        'reason': 'UPDATE users SET <status/custom_status/bio> WHERE id = $N; binds claims.sub (i64). '
                  'Field set disjoint from handlers::update_profile, so the two builders never emit one text.',
        'builders': [{
            'emits': r'UPDATE users SET ' + _set_list(_COLS_STATUS) + r' WHERE id = \$\d+',
            'params': {'status': 'TEXT', 'custom_status': 'TEXT', 'bio': 'TEXT', 'id': 'i64'},
        }],
    },
    ('src/role_handlers.rs', 'update_role'): {
        'reason': 'QueryBuilder: UPDATE server_roles SET <fields present> WHERE id = $N AND server_id = $M '
                  '(server_roles.id is BIGSERIAL).',
        'builders': [{
            'emits': r'UPDATE server_roles SET ' + _set_list(_COLS_ROLE) + r' WHERE id = \$\d+ AND server_id = \$\d+',
            'params': {'name': 'TEXT', 'color': 'TEXT', 'permissions': 'i64', 'position': 'i32',
                       'id': 'i64', 'server_id': 'TEXT'},
        }],
    },
    ('src/server_handlers.rs', 'update_server_settings'): {
        'reason': 'QueryBuilder: UPDATE servers SET <fields present> WHERE id = $N.',
        'builders': [{
            'emits': r'UPDATE servers SET ' + _set_list(_COLS_SERVER) + r' WHERE id = \$\d+',
            'params': {'clips_enabled': 'bool', 'games_enabled': 'bool', 'clip_max_seconds': 'i32', 'clip_channel_id': 'i32',
                       'name': 'TEXT', 'is_public': 'bool', 'require_media_e2ee': 'bool',
                       'afk_timeout_minutes': 'i32', 'description': 'TEXT', 'icon_file_id': 'TEXT',
                       'id': 'TEXT'},
        }],
    },
    ('src/task_handlers.rs', 'update_task'): {
        'reason': 'the edit and the why-refused SELECT, each format!-ed around task_timing::item_fresh_sql(..), '
                  'a fn call the resolver does not evaluate; binds chained, so rustc types them.',
        'builders': [
            {'emits': r'UPDATE channel_tasks SET is_completed = COALESCE\(\$1, is_completed\), '
                      r'description = COALESCE\(\$2, description\), .* WHERE id = \$7 AND .*',
             'positional': True},
            {'emits': r'SELECT \(\$2::timestamptz IS NULL OR .* FROM channel_tasks WHERE id = \$1',
             'positional': True},
        ],
    },
}

QUERY_FNS = ('query_as_with', 'query_scalar_with', 'query_with', 'query_as', 'query_scalar', 'query')
CALL = re.compile(r'\bsqlx\s*::\s*(' + '|'.join(QUERY_FNS) + r')\b\s*(::\s*<)?')
BUILDER = re.compile(r'(?<![\w$])QueryBuilder\b\s*(::\s*<)?')
TERMINALS = ('fetch_one', 'fetch_optional', 'fetch_all', 'fetch', 'execute', 'fetch_many')
CONTROL_TEXT = 'SELECT $1::int8 IS NOT NULL /* check-sql-bind-types positive control */'
CONTROL_OTHER = 'SELECT $1::text IS NOT NULL /* check-sql-bind-types positive control, other text */'
CONTROL_MODULE = '''

#[cfg(test)]
#[allow(dead_code)]
mod __check_sql_bind_types_control {
    async fn binds_i32(pool: &sqlx::PgPool) {
        let _ = sqlx::query("%s").bind(1_i32).execute(pool).await;
    }
    // The width is fixed only AFTER the bind, and another probe in this fn
    // fails first: a probe that reported before inference finished, or that
    // lost later diagnostics to an earlier one, would call this i32 - no pair.
    async fn binds_i64_late(pool: &sqlx::PgPool) {
        let _ = sqlx::query("%s").bind(String::new()).execute(pool).await;
        let v = 1;
        let _ = sqlx::query("%s").bind(v).execute(pool).await;
        let _: i64 = v;
    }
}
''' % (CONTROL_TEXT, CONTROL_OTHER, CONTROL_TEXT)
PROBE_DEFS = '''

#[doc(hidden)]
#[allow(dead_code)]
pub(crate) trait __BwProbe<const N: usize, U> {}
impl<T, const N: usize> __BwProbe<N, u8> for T {}
impl<T, const N: usize> __BwProbe<N, u16> for T {}
#[doc(hidden)]
#[allow(dead_code)]
pub(crate) fn __bw_probe<const N: usize, T, U>(x: T) -> T where T: __BwProbe<N, U> { x }
'''
PROBE_SEEN = re.compile(r'`([^`]+):\s(?:[A-Za-z_][A-Za-z0-9_]*::)*__BwProbe<(\d+), _>`')
MAX_TEXTS = 64


class Ambiguous(Exception):
    pass


# ---------------------------------------------------------------- Rust lexing

def skip_generics(s, i):
    depth = 1
    while depth:
        if s[i] == '<':
            depth += 1
        elif s[i] == '>' and s[i - 1] != '-':
            depth -= 1
        i += 1
    return i


def read_string(s, i):
    """A Rust string literal at s[i] (optionally b/c/r-prefixed) -> (runtime value, index after it)."""
    m = re.match(r'(?:b|c)?r(#*)"', s[i:i + 12])
    if m:
        hashes = m.group(1)
        start = i + len(m.group(0))
        end = s.index('"' + hashes, start)
        return s[start:end].replace('\r\n', '\n'), end + 1 + len(hashes)
    if s[i] in 'bc' and s[i + 1] == '"':
        i += 1
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


def blank(s):
    """s with every comment, and the inside of every string and char literal,
    replaced by spaces (line breaks kept), so offsets and line numbers are
    unchanged. Structure is read from this; literal values from the original."""
    out, j, n = list(s), 0, len(s)
    while j < n:
        k = skip_token(s, j)
        if k is None:
            j += 1
            continue
        comment = s.startswith('//', j) or s.startswith('/*', j)
        lo, hi = (j, k) if comment else (j + 1, k - 1)
        for q in range(lo, hi):
            if out[q] not in '\r\n':
                out[q] = ' '
        j = k
    return ''.join(out)


def balanced(b, i, open_c='(', close_c=')'):
    """b[i] == open_c in BLANKED text -> index just past its partner."""
    depth, j = 0, i
    while True:
        c = b[j]
        if c == open_c:
            depth += 1
        elif c == close_c:
            depth -= 1
            if depth == 0:
                return j + 1
        j += 1


def split_top(b, a, z):
    """Top-level comma-separated pieces of b[a:z] (BLANKED) as (start, end) spans."""
    out, depth, start = [], 0, a
    for j in range(a, z):
        c = b[j]
        if c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
        elif c == ',' and depth == 0:
            out.append((start, j))
            start = j + 1
    if b[start:z].strip():
        out.append((start, z))
    return out


def trim(b, a, z):
    """Strip whitespace (comments are whitespace in BLANKED text) and one trailing top-level comma."""
    while a < z and b[a].isspace():
        a += 1
    while z > a and b[z - 1].isspace():
        z -= 1
    if z > a and b[z - 1] == ',':
        z -= 1
        while z > a and b[z - 1].isspace():
            z -= 1
    return a, z


# ---------------------------------------------------------------- crate model

class Src:
    def __init__(self, path, text):
        self.path = path
        self.s = text
        self.b = blank(text)
        self.fns = self._fns()
        self.mods = self._inline_mods()
        self.test_spans = self._test_items()
        self.modpath = self._file_modpath()

    def line(self, pos):
        return self.s.count('\n', 0, pos) + 1

    def _fns(self):
        out = []
        for m in re.finditer(r'\bfn\s+([A-Za-z_][A-Za-z0-9_]*)', self.b):
            j, depth = m.end(), 0
            while j < len(self.b):
                c = self.b[j]
                if c in '([':
                    depth += 1
                elif c in ')]':
                    depth -= 1
                elif depth == 0 and c in '{;':
                    break
                j += 1
            if j >= len(self.b) or self.b[j] == ';':
                continue
            out.append({'name': m.group(1), 'start': m.start(), 'body': j, 'end': balanced(self.b, j, '{', '}')})
        return out

    def fn_at(self, pos):
        inside = [f for f in self.fns if f['body'] < pos < f['end']]
        return max(inside, key=lambda f: f['body']) if inside else None

    def fn_name(self, pos):
        f = self.fn_at(pos)
        return f['name'] if f else '?'

    def _inline_mods(self):
        out = []
        for m in re.finditer(r'\bmod\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{', self.b):
            out.append({'name': m.group(1), 'start': m.start(), 'end': balanced(self.b, m.end() - 1, '{', '}')})
        return out

    def _test_items(self):
        """[(start, end)] of every item carrying #[cfg(test)] (a module, fn, impl,
        `mod x;` ...). Test fixtures in this repo hold fake Rust source,
        attributes and braces included, inside raw strings: hence BLANKED text."""
        out, b = [], self.b
        self.test_mod_decls = []
        for m in re.finditer(r'#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]', b):
            q, depth = m.end(), 0
            while q < len(b):
                c = b[q]
                if c in '([':
                    depth += 1
                elif c in ')]':
                    depth -= 1
                elif depth == 0 and c == ';':
                    q += 1
                    break
                elif depth == 0 and c == '{':
                    q = balanced(b, q, '{', '}')
                    break
                q += 1
            out.append((m.start(), q))
            decl = re.search(r'\bmod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;\s*$', b[m.end():q])
            if decl:
                self.test_mod_decls.append((decl.group(1), m.start()))
        return out

    def _file_modpath(self):
        parts = self.path[len('src/'):-len('.rs')].split('/')
        if parts[-1] in ('main', 'lib', 'mod'):
            parts = parts[:-1]
        return parts

    def child_dir(self):
        base = os.path.basename(self.path)
        return os.path.dirname(self.path) if base in ('main.rs', 'lib.rs', 'mod.rs') else self.path[:-3]

    def modpath_at(self, pos):
        return self.modpath + [m['name'] for m in sorted(self.mods, key=lambda m: m['start'])
                               if m['start'] < pos < m['end']]

    def in_test(self, pos):
        return self.whole_file_test or any(a <= pos < b for a, b in self.test_spans)


class Crate:
    def __init__(self, files):
        self.files = {p: Src(p, t) for p, t in files.items()}
        for f in self.files.values():
            f.whole_file_test = False
        self._mark_test_files()
        self.consts, self.arrays = self._collect_consts()

    def _mark_test_files(self):
        """Files reached through `#[cfg(test)] mod x;` (and everything below them) are test code."""
        changed = True
        while changed:
            changed = False
            for f in list(self.files.values()):
                decls = list(f.test_mod_decls)
                if f.whole_file_test:
                    decls += [(m.group(1), m.start()) for m in re.finditer(r'\bmod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;', f.b)]
                for name, pos in decls:
                    inline = [m['name'] for m in sorted(f.mods, key=lambda m: m['start']) if m['start'] < pos < m['end']]
                    d = '/'.join([f.child_dir()] + inline + [name])
                    for cand in (d + '.rs', d + '/mod.rs'):
                        for p, g in self.files.items():
                            if (p == cand or p.startswith(d + '/')) and not g.whole_file_test:
                                g.whole_file_test = changed = True

    def _collect_consts(self):
        consts, arrays = {}, {}
        scalar = re.compile(r"\bconst\s+([A-Z_][A-Z0-9_]*)\s*:\s*&\s*(?:'static\s+)?str\s*=\s*")
        array = re.compile(r"\bconst\s+([A-Z_][A-Z0-9_]*)\s*:\s*&\s*(?:'static\s+)?\[\s*&\s*(?:'static\s+)?str\s*\]\s*=\s*&\s*\[")
        for f in self.files.values():
            for m in scalar.finditer(f.b):
                end = f.b.index(';', m.end())
                vals = self.literal_texts(f, m.end(), end)
                if vals and len(vals) == 1:
                    consts.setdefault(m.group(1), []).append(self._def(f, m.start(), vals[0]))
            for m in array.finditer(f.b):
                z = balanced(f.b, m.end() - 1, '[', ']')
                items = []
                for a, z2 in split_top(f.b, m.end(), z - 1):
                    a, z2 = trim(f.b, a, z2)
                    if a < z2:
                        v = self.literal_texts(f, a, z2)
                        items.append(v[0] if v and len(v) == 1 else None)
                if all(x is not None for x in items):
                    arrays.setdefault(m.group(1), []).append(self._def(f, m.start(), tuple(items)))
        return consts, arrays

    def _def(self, f, pos, value):
        fn = f.fn_at(pos)
        mods = [m for m in f.mods if m['start'] < pos < m['end']]
        if fn:
            scope = (fn['body'], fn['end'])
        elif mods:
            inner = max(mods, key=lambda m: m['start'])
            scope = (inner['start'], inner['end'])
        else:
            scope = (0, len(f.s))
        return {'file': f.path, 'scope': scope, 'fnlocal': fn is not None, 'modpath': f.modpath_at(pos), 'value': value}

    def literal_texts(self, f, a, z):
        """Texts of a literal / concat! of literals at f[a:z]; None otherwise."""
        a, z = trim(f.b, a, z)
        if a >= z:
            return None
        if f.b[a] in 'rbc"' and re.match(r'(?:b|c)?(?:r#*)?"', f.s[a:a + 12]):
            val, end = read_string(f.s, a)
            return [val] if end == z else None
        m = re.match(r'concat!\s*\(', f.b[a:z])
        if m:
            close = balanced(f.b, a + m.end() - 1)
            if close != z:
                return None
            parts = []
            for p, q in split_top(f.b, a + m.end(), close - 1):
                p, q = trim(f.b, p, q)
                if p >= q:
                    continue
                if f.b[p] in 'rbc"':
                    v = self.literal_texts(f, p, q)
                    if not v:
                        return None
                    parts.append(v[0])
                elif re.fullmatch(r'-?\d+(?:\.\d+)?|true|false', f.s[p:q]):
                    parts.append(f.s[p:q])
                else:
                    return None
            return [''.join(parts)]
        return None

    def resolve(self, table, expr, f, pos):
        """A const (or const array) named by `expr` (`NAME`, `m::NAME`, `crate::m::NAME`, ...)
        as seen from f at pos -> its value, or None when no such const exists.
        Raises Ambiguous when the name has two definitions and the path does not pick one."""
        segs = [x.strip() for x in expr.split('::')]
        name, path = segs[-1], [x for x in segs[:-1] if x]
        defs = table.get(name, [])
        if not defs:
            return None
        values = {repr(d['value']) for d in defs}
        if not path:
            local = [d for d in defs if d['file'] == f.path and d['scope'][0] <= pos < d['scope'][1]]
            if local:
                return max(local, key=lambda d: d['scope'][0])['value']
            if len(values) == 1:
                return defs[0]['value']
            raise Ambiguous('%s (defined %d times: %s)' % (name, len(defs), ', '.join(sorted({d['file'] for d in defs}))))
        cur = f.modpath_at(pos)
        moddefs = [d for d in defs if not d['fnlocal']]
        if path[0] == 'crate':
            targets = [path[1:]]
        elif path[0] in ('self', 'super'):
            k = 0
            while k < len(path) and path[k] == 'super':
                k += 1
            base = cur if k == 0 else cur[:len(cur) - k]
            targets = [base + path[1 if path[0] == 'self' else k:]]
        else:
            targets = [cur + path, path]
        for t in targets:
            hit = [d for d in moddefs if d['modpath'] == t]
            if hit:
                return hit[0]['value']
        hit = [d for d in moddefs if d['modpath'][-len(path):] == path]
        if len({repr(d['value']) for d in hit}) == 1:
            return hit[0]['value']
        if not hit and len(values) == 1:
            return defs[0]['value']
        raise Ambiguous('%s::%s (defined %d times: %s)' % ('::'.join(path), name, len(defs),
                                                           ', '.join(sorted({d['file'] for d in defs}))))

    # ---- what text(s) does an expression evaluate to?

    def texts(self, f, a, z, depth=0):
        """Every runtime text f[a:z] can evaluate to (a list), or None if it depends on runtime values."""
        if depth > 8:
            return None
        a, z = trim(f.b, a, z)
        while a < z and f.b[a] in '&*':
            a, z = trim(f.b, a + 1, z)
        if a >= z:
            return None
        m = re.search(r'\.\s*(?:as_str|as_ref|to_string|to_owned|into)\s*\(\s*\)$', f.b[a:z])
        if m:
            return self.texts(f, a, a + m.start(), depth + 1)
        if f.b[a] == '(' and balanced(f.b, a) == z:
            return self.texts(f, a + 1, z - 1, depth + 1)
        lit = self.literal_texts(f, a, z)
        if lit:
            return lit
        e = f.b[a:z]
        if re.fullmatch(r'(?:(?:crate|self|super|[a-z_][a-z0-9_]*)\s*::\s*)*[A-Z_][A-Z0-9_]*', e):
            v = self.resolve(self.consts, re.sub(r'\s+', '', e), f, a)
            return [v] if v is not None else None
        m = re.match(r'format!\s*\(', e)
        if m and balanced(f.b, a + m.end() - 1) == z:
            return self._format(f, a + m.end(), z - 1, depth)
        if re.fullmatch(r'[a-z_][a-z0-9_]*', e):
            return self.local_texts(f, e, a, depth)
        if re.match(r'if\b', e):
            return self._if_texts(f, a, z, depth)
        if e.startswith('{') and balanced(f.b, a, '{', '}') == z and ';' not in f.b[a + 1:z - 1]:
            return self.texts(f, a + 1, z - 1, depth + 1)
        return None

    def _if_texts(self, f, a, z, depth):
        out, j = [], a
        while True:
            m = re.match(r'if\b', f.b[j:z])
            if not m:
                return None
            k, d = j + 2, 0
            while k < z and not (f.b[k] == '{' and d == 0):
                if f.b[k] in '([':
                    d += 1
                elif f.b[k] in ')]':
                    d -= 1
                k += 1
            if k >= z:
                return None
            end = balanced(f.b, k, '{', '}')
            if ';' in f.b[k + 1:end - 1]:
                return None
            t = self.texts(f, k + 1, end - 1, depth + 1)
            if t is None:
                return None
            out += t
            m = re.match(r'\s*else\s*', f.b[end:z])
            if not m:
                return None         # no else: a runtime-dependent value
            j = end + m.end()
            if f.b[j] == '{':
                end2 = balanced(f.b, j, '{', '}')
                if end2 != z or ';' in f.b[j + 1:end2 - 1]:
                    return None
                t = self.texts(f, j + 1, end2 - 1, depth + 1)
                return None if t is None else out + t

    def _format(self, f, a, z, depth):
        args = split_top(f.b, a, z)
        if not args:
            return None
        ta, tz = trim(f.b, *args[0])
        tmpl = self.literal_texts(f, ta, tz)
        if not tmpl:
            return None
        tmpl = tmpl[0]
        positional, named = [], {}
        for p, q in args[1:]:
            p, q = trim(f.b, p, q)
            if p >= q:
                continue
            nm = re.match(r'([a-z_][a-z0-9_]*)\s*=(?!=)\s*', f.b[p:q])
            if nm:
                named[nm.group(1)] = (p + nm.end(), q)
            else:
                positional.append((p, q))
        pieces, choices, nxt, k = [], [], 0, 0
        while k < len(tmpl):
            c = tmpl[k]
            if tmpl.startswith('{{', k) or tmpl.startswith('}}', k):
                pieces.append(c)
                k += 2
                continue
            if c == '{':
                end = tmpl.index('}', k)
                spec = tmpl[k + 1:end]
                if ':' in spec:
                    return None
                if spec == '':
                    if nxt >= len(positional):
                        return None
                    t = self.texts(f, *positional[nxt], depth=depth + 1)
                    nxt += 1
                elif spec.isdigit():
                    if int(spec) >= len(positional):
                        return None
                    t = self.texts(f, *positional[int(spec)], depth=depth + 1)
                elif spec in named:
                    t = self.texts(f, *named[spec], depth=depth + 1)
                elif re.fullmatch(r'[a-z_][a-z0-9_]*', spec):
                    t = self.local_texts(f, spec, a, depth)
                elif re.fullmatch(r'[A-Z_][A-Z0-9_]*', spec):
                    v = self.resolve(self.consts, spec, f, a)
                    t = [v] if v is not None else None
                else:
                    return None
                if t is None:
                    return None
                pieces.append(None)
                choices.append(t)
                k = end + 1
                continue
            pieces.append(c)
            k += 1
        total = 1
        for c in choices:
            total *= len(c)
        if total > MAX_TEXTS:
            return None
        out = []
        for combo in itertools.product(*choices):
            it = iter(combo)
            out.append(''.join(next(it) if p is None else p for p in pieces))
        return out

    def local_texts(self, f, name, pos, depth):
        """`name` at pos -> the texts of its `let` in the enclosing fn, or None (no let,
        a runtime value, or reassigned/mutated between the let and pos)."""
        fn = f.fn_at(pos)
        if not fn:
            return None
        body = f.b[fn['body']:pos]
        lets = list(re.finditer(r'\blet\s+(?:mut\s+)?' + re.escape(name) + r'\b\s*(?::[^=;]*)?=(?!=)\s*', body))
        if not lets:
            return None
        a = fn['body'] + lets[-1].end()
        j, d = a, 0
        while j < pos:
            c = f.b[j]
            if c in '([{':
                d += 1
            elif c in ')]}':
                d -= 1
            elif c == ';' and d == 0:
                break
            j += 1
        if j >= pos:
            return None
        after = f.b[j:pos]
        if re.search(r'\b' + re.escape(name) + r'\s*(?:\+?=(?!=)|\.\s*(?:push_str|push|insert_str|insert|clear|truncate|extend)\b)', after) \
                or re.search(r'\bwrite(?:ln)?!\s*\(\s*&?\s*(?:mut\s+)?' + re.escape(name) + r'\b', after):
            return None
        return self.texts(f, a, j, depth + 1)


# ---------------------------------------------------------------- sites

def sqlx_imports(f):
    """Bare names that call a sqlx query fn in this file: {local name: sqlx fn}."""
    out = {}
    for m in re.finditer(r'\buse\s+sqlx\s*::\s*', f.b):
        j = m.end()
        if f.b[j] == '{':
            z = balanced(f.b, j, '{', '}')
            items = [f.b[p:q].strip() for p, q in split_top(f.b, j + 1, z - 1)]
        elif f.b[j] == '*':
            items = list(QUERY_FNS)
        else:
            items = [f.b[j:f.b.index(';', j)].strip()]
        for it in items:
            mm = re.fullmatch(r'(' + '|'.join(QUERY_FNS) + r')(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?', it)
            if mm:
                out[mm.group(2) or mm.group(1)] = mm.group(1)
    return out


def bind_chain(f, i):
    """The `.bind(..)` argument spans chained after f[i] (BLANKED scan, so comments are skipped)."""
    out, j, b = [], i, f.b
    while True:
        m = re.compile(r'\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*').match(b, j)
        if not m:
            return out
        k = m.end()
        if b.startswith('::', k):
            k2 = re.compile(r'::\s*<').match(b, k)
            if not k2:
                return out
            k = skip_generics(b, k2.end())
            while b[k].isspace():
                k += 1
        if k >= len(b) or b[k] != '(':
            return out
        after = balanced(b, k)
        if m.group(1) == 'bind':
            a, z = trim(b, k + 1, after - 1)
            out.append((a, z))
        elif m.group(1) in TERMINALS:
            return out
        j = after


def find_sites(crate):
    sites = []
    for f in crate.files.values():
        b = f.b
        bare = sqlx_imports(f)
        found = []
        for m in CALL.finditer(b):
            found.append((m, m.group(1)))
        if bare:
            pat = re.compile(r'(?<![\w.:$])(' + '|'.join(map(re.escape, bare)) + r')\b\s*(::\s*<)?')
            for m in pat.finditer(b):
                if re.search(r'\bfn\s*$', b[:m.start()]) or re.search(r'\buse\s+[^;]*$', b[max(0, m.start() - 200):m.start()]):
                    continue
                found.append((m, bare[m.group(1)]))
        for m, fn in found:
            i = skip_generics(b, m.end()) if m.group(2) else m.end()
            while b[i].isspace():
                i += 1
            if b[i] != '(':
                continue
            close = balanced(b, i)
            site = new_site(crate, f, m.start(), i + 1, close - 1)
            site['binds'] = [{'span': (f.path, a, z), 'expr': ' '.join(f.s[a:z].split())} for a, z in bind_chain(f, close)]
            site['with_args'] = fn.endswith('_with')
            sites.append(site)
        for m in BUILDER.finditer(b):
            i = skip_generics(b, m.end()) if m.group(1) else m.end()
            mm = re.compile(r'\s*::\s*(new|with_arguments)\s*\(').match(b, i)
            if not mm:
                continue
            close = balanced(b, mm.end() - 1)
            site = new_site(crate, f, m.start(), mm.end(), close - 1, builder=True)
            sites.append(site)
    return sites


def new_site(crate, f, pos, a, z, builder=False):
    site = {'file': f.path, 'line': f.line(pos), 'fn': f.fn_name(pos), 'pos': pos, 'test': f.in_test(pos),
            'arg': ' '.join(f.s[a:z].split()), 'argspan': (a, z), 'binds': [], 'texts': None, 'how': 'dynamic',
            'builder': builder, 'with_args': False}
    if builder:
        site['how'] = 'QueryBuilder'
        return site
    try:
        site['texts'] = crate.texts(f, a, z)
    except Ambiguous as e:
        site['how'] = 'ambiguous'
        site['ambiguous'] = str(e)
        return site
    if site['texts'] is not None:
        site['how'] = 'static'
    return site


def expand_indirect(crate, sites):
    """Texts reaching sqlx through a loop over a const array, or a helper's parameter.
    -> (extra text sites, unresolvable production helper calls)."""
    extra, unresolved = [], []
    for site in sites:
        if site['how'] != 'dynamic' or site['builder']:
            continue
        f = crate.files[site['file']]
        a, z = trim(f.b, *site['argspan'])
        while a < z and f.b[a] in '&*':
            a += 1
        name = f.b[a:z].strip()
        if not re.fullmatch(r'[a-z_][a-z0-9_]*', name):
            continue
        fn = f.fn_at(site['pos'])
        if not fn:
            continue
        body = f.b[fn['body']:site['pos']]
        loop = re.findall(r'\bfor\s+' + re.escape(name) + r'\s+in\s+(?:&\s*)?((?:[a-z_][a-z0-9_]*\s*::\s*)*[A-Z_][A-Z0-9_]*)', body)
        if loop:
            try:
                arr = crate.resolve(crate.arrays, re.sub(r'\s+', '', loop[-1]), f, site['pos'])
            except Ambiguous as e:
                site['how'], site['ambiguous'] = 'ambiguous', str(e)
                continue
            if arr is not None:
                site['how'] = 'loop'
                extra += [dict(site, how='array ' + loop[-1], texts=[t]) for t in arr]
                continue
        if re.search(r'\blet\s+(?:mut\s+)?' + re.escape(name) + r'\b', body):
            continue
        sig = f.b[fn['start']:fn['body']]
        sm = re.match(r'fn\s+[A-Za-z_][A-Za-z0-9_]*\s*', sig)
        j0 = skip_generics(sig, sm.end() + 1) if sig[sm.end()] == '<' else sm.end()
        po = sig.find('(', j0)
        if po < 0:
            continue
        params = []
        for p, q in split_top(sig, po + 1, balanced(sig, po) - 1):
            params.append(sig[p:q].split(':')[0].replace('mut ', '').replace('&', '').strip())
        has_self = bool(params) and params[0] == 'self'
        params_ns = params[1:] if has_self else params
        if name not in params_ns:
            continue
        idx, helper = params_ns.index(name), fn['name']
        site['how'] = 'helper'
        modname = f.modpath[-1] if f.modpath else None
        for g in crate.files.values():
            # Calls of THIS helper: same file, imported by name, path-qualified, or a method call.
            imported = g.path == f.path or (modname and re.search(
                r'\buse\b[^;]*\b' + re.escape(modname) + r'\b[^;]*\b' + re.escape(helper) + r'\b', g.b))
            for cm in re.finditer(r'(?<![\w$])' + re.escape(helper) + r'\b\s*(?:::\s*<)?', g.b):
                if re.search(r'\bfn\s*$', g.b[:cm.start()]):
                    continue
                before = g.b[max(0, cm.start() - 80):cm.start()]
                qualified = modname and re.search(r'\b' + re.escape(modname) + r'\s*::\s*$', before)
                if not (imported or qualified or before.rstrip().endswith('.')):
                    continue
                j = skip_generics(g.b, cm.end()) if cm.group(0).rstrip().endswith('<') else cm.end()
                while j < len(g.b) and g.b[j].isspace():
                    j += 1
                if j >= len(g.b) or g.b[j] != '(':
                    continue
                method = g.b[:cm.start()].rstrip().endswith('.')
                k = idx if (method or not has_self) else idx + 1
                args = split_top(g.b, j + 1, balanced(g.b, j) - 1)
                if k >= len(args):
                    continue
                call = {'file': g.path, 'line': g.line(cm.start()), 'fn': g.fn_name(cm.start()),
                        'test': g.in_test(cm.start()), 'pos': cm.start()}
                try:
                    t = crate.texts(g, *args[k])
                except Ambiguous as e:
                    unresolved.append(dict(site, **call, how='ambiguous', ambiguous=str(e), texts=None))
                    continue
                if t is None:
                    if not call['test']:
                        unresolved.append(dict(site, **call, how='dynamic', texts=None,
                                               arg='%s(.., %s, ..)' % (helper, ' '.join(g.s[args[k][0]:args[k][1]].split()))))
                    continue
                for text in t:
                    extra.append(dict(site, **call, how='via %s()' % helper, texts=[text]))
    return extra, unresolved


# ---------------------------------------------------------------- types

def pg_type(t):
    """What Postgres sees: references, Option, paths and lifetimes do not change the parameter type."""
    if t is None:
        return None
    t = re.sub(r"'[A-Za-z_]+\s*,\s*", '', t)
    t = re.sub(r"'[A-Za-z_]+\s*", '', t)
    t = re.sub(r'\b(?:[a-z_][a-z0-9_]*::)+', '', t)
    t = re.sub(r'&\s*(?:mut\s+)?', '', t)
    t = re.sub(r'\s+', ' ', t).strip()
    return _norm(t)


def _norm(t):
    t = t.strip()
    m = re.fullmatch(r'(?:Option|Box|Arc|Rc|Cow)<(.*)>', t)
    if m:
        return _norm(m.group(1))
    if t in ('String', 'str'):
        return 'TEXT'
    if t == '{integer}':
        return 'i32'
    if t == '{float}':
        return 'f64'
    if re.fullmatch(r'Json<.*>|Value|JsonValue', t):
        return 'JSONB'
    m = re.fullmatch(r'Vec<(.*)>', t) or re.fullmatch(r'\[(.*?)(?:;\s*\d+)?\]', t)
    if m:
        inner = _norm(m.group(1))
        return 'BYTEA' if inner == 'u8' else inner + '[]'
    return t


def max_param(text):
    return max((int(x) for x in re.findall(r'\$(\d+)', text)), default=0)


# ---------------------------------------------------------------- the check

def read_probes(stdout):
    """cargo's JSON -> ({probe id: type}, [rendered errors that are not probes])."""
    types, other = {}, []
    for line in stdout.splitlines():
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get('reason') != 'compiler-message':
            continue
        msg = msg['message']
        if msg.get('level') not in ('error', 'error: internal compiler error'):
            continue
        texts = [msg.get('message') or ''] + [c.get('message') or '' for c in msg.get('children', [])]
        hits = [h for h in (PROBE_SEEN.search(t) for t in texts) if h]
        if hits:
            types[int(hits[0].group(2))] = hits[0].group(1).strip()
        elif msg.get('spans'):
            other.append((msg.get('rendered') or msg.get('message') or '').strip())
    return types, other


def main():
    keep = '--keep-temp' in sys.argv
    dump = sys.argv[sys.argv.index('--dump-sites') + 1] if '--dump-sites' in sys.argv else None
    raw = {}
    for dp, _, names in os.walk(os.path.join(ROOT, 'src')):
        for name in names:
            if name.endswith('.rs'):
                p = os.path.join(dp, name)
                with open(p, encoding='utf-8', newline='') as fh:
                    raw[os.path.relpath(p, ROOT).replace('\\', '/')] = fh.read()
    if 'src/main.rs' not in raw:
        print('check-sql-bind-types: src/main.rs not found', file=sys.stderr)
        return 2
    raw['src/main.rs'] += CONTROL_MODULE          # the positive control, temp copy only
    crate = Crate(raw)
    sites = find_sites(crate)
    extra, unresolved_calls = expand_indirect(crate, sites)

    # Every chained bind, and every loose bind/push_bind inside a reviewed fn, gets a probe.
    probes, n = {}, 0
    chained = set()
    for site in sites:
        for bd in site['binds']:
            n += 1
            bd['id'] = n
            probes[bd['span']] = n
            chained.add(bd['span'])
    loose = {}
    for (path, fn_name), entry in REVIEWED_RUNTIME_SQL.items():
        f = crate.files.get(path)
        if not f:
            continue
        for fn in [x for x in f.fns if x['name'] == fn_name]:
            for m in re.finditer(r'\.\s*(push_bind|bind)\s*\(', f.b[fn['body']:fn['end']]):
                k = fn['body'] + m.end() - 1
                a, z = trim(f.b, k + 1, balanced(f.b, k) - 1)
                if (path, a, z) in chained:
                    continue
                # A push_bind's column is the `col = ` its builder pushed just
                # before it, so its type is checked against THAT column's.
                col = None
                if m.group(1) == 'push_bind':
                    pm = re.search(r'\bpush\s*\(\s*("\s*")\s*\)\s*$', f.b[fn['body']:fn['body'] + m.start()])
                    if pm:
                        pushed, _ = read_string(f.s, fn['body'] + pm.start(1))
                        cm = re.search(r'([a-z_][a-z0-9_]*)\s*=\s*$', pushed)
                        col = cm.group(1) if cm else None
                n += 1
                probes[(path, a, z)] = n
                loose.setdefault((path, fn_name), []).append({'id': n, 'expr': ' '.join(f.s[a:z].split()),
                                                              'line': f.line(a), 'col': col})

    # rustc reports a fn's probe ambiguities only if no error at all was
    # emitted while that fn was being type-checked. Measured on this crate: one
    # pass leaves every bind in main, ws::ws_handler and an auth middleware
    # test untyped - fns that hand other async fns to axum, whose probes fire
    # while they are checked. Hence passes: each probes only the binds still
    # untyped, until none are left or a pass types nothing new (code compiled
    # out on this platform). A bind left untyped on a shared text fails below.
    tmp = tempfile.mkdtemp(prefix='sql-bind-check-')
    skip = {'.git', 'target', 'node_modules', 'dist', 'dist-desktop', '.gradle', 'build', 'android', 'ios', 'src-tauri'}
    types, passes, r = {}, 0, None
    try:
        for item in os.listdir(ROOT):
            if item in skip:
                continue
            src = os.path.join(ROOT, item)
            if os.path.isdir(src):
                shutil.copytree(src, os.path.join(tmp, item), ignore=lambda d, names: [x for x in names if x in skip])
            else:
                shutil.copy2(src, os.path.join(tmp, item))
        # Files src/ embeds from the trees skipped above (the Android pure-Java
        # sources some tests pin): without them those fns fail to compile, and
        # a fn with any error hides every probe in it.
        for path, text in raw.items():
            for m in re.finditer(r'include_(?:str|bytes)!\s*\(\s*"([^"]+)"', text):
                rel = os.path.normpath(os.path.join(os.path.dirname(path), m.group(1)))
                src, dst = os.path.join(ROOT, rel), os.path.join(tmp, rel)
                if os.path.isfile(src) and not os.path.exists(dst):
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.copy2(src, dst)
        env = dict(os.environ)
        env.setdefault('CARGO_TARGET_DIR', os.path.join(ROOT, 'target', 'sql-bind-check'))
        touched = {span[0] for span in probes} | {'src/main.rs'}
        remaining = set(probes.values())
        while remaining and passes < 8:
            passes += 1
            inserts = {}
            for (path, a, z), pid in probes.items():
                if pid in remaining:
                    inserts.setdefault(path, []).append((a, 0, 'crate::__bw_probe::<%d, _, _>(' % pid))
                    inserts.setdefault(path, []).append((z, 1, '\n)'))
            for path in touched:
                s = raw[path]
                # Back to front; at one offset a closing `)` goes before an opening probe.
                for pos, order, txt in sorted(inserts.get(path, []), key=lambda x: (-x[0], -x[1])):
                    s = s[:pos] + txt + s[pos:]
                if path == 'src/main.rs':
                    s += PROBE_DEFS
                with open(os.path.join(tmp, path), 'w', encoding='utf-8', newline='') as fh:
                    fh.write(s)
            r = subprocess.run(['cargo', 'check', '--tests', '--message-format=json'], cwd=tmp, env=env,
                               capture_output=True, text=True, encoding='utf-8', errors='replace')
            got, other_errors = read_probes(r.stdout)
            if other_errors:
                print('check-sql-bind-types: BROKEN - the probed copy has compiler errors that are not probes '
                      '(an error hides every probe in the fn it is in, and in any fn checking it):', file=sys.stderr)
                for e in other_errors[:5]:
                    print(e, file=sys.stderr)
                return 2
            got = {k: v for k, v in got.items() if k in remaining}
            types.update(got)
            if not got:
                break
            remaining -= set(got)
    finally:
        if keep:
            print('temp copy kept at', tmp)
        else:
            shutil.rmtree(tmp, ignore_errors=True)

    # ---- the check can fail, or it proves nothing ----
    if n == 0 or len(types) < 0.97 * n:
        print(f'check-sql-bind-types: BROKEN - rustc typed {len(types)} of {n} binds '
              f'(cargo exit {r.returncode}); the probe no longer reads the compiler.', file=sys.stderr)
        tail = [x for x in r.stderr.splitlines() if x.strip()][-15:]
        print('\n'.join(tail), file=sys.stderr)
        return 2
    for site in sites:
        for bd in site['binds']:
            bd['type'] = types.get(bd['id'])
    for lst in loose.values():
        for bd in lst:
            bd['type'] = types.get(bd['id'])

    text_sites = []
    for x in sites + extra:
        if x['how'] in ('dynamic', 'loop', 'helper', 'ambiguous', 'QueryBuilder'):
            continue
        for t in dict.fromkeys(x['texts']):
            text_sites.append(dict(x, text=t))
    groups = {}
    for x in text_sites:
        groups.setdefault(x['text'], []).append(x)

    found = []          # (text, pos, {pg type: [(site, bind)]})

    def compare(text, members):
        width = max((len(x['binds']) for x, _ in members), default=0)
        for pos in range(width):
            by = {}
            for x, override in members:
                if override is not None:
                    if pos in override:
                        by.setdefault(override[pos]['pg'], []).append((x, override[pos]))
                    continue
                if pos < len(x['binds']) and x['binds'][pos].get('type'):
                    bd = x['binds'][pos]
                    by.setdefault(pg_type(bd['type']), []).append((x, bd))
            if len(by) > 1:
                found.append((text, pos, by))

    # A text a reviewed builder can emit is compared once, builder included (below).
    specs = [spec for entry in REVIEWED_RUNTIME_SQL.values() for spec in entry['builders']]
    builder_texts = {t for t in groups if any(re.fullmatch(spec['emits'], t, re.S) for spec in specs)}
    for text, g in groups.items():
        if len(g) > 1 and text not in builder_texts:
            compare(text, [(x, None) for x in g])

    # Static texts a reviewed builder could also emit.
    dyn_by_fn = {}
    for x in sites:
        if x['how'] in ('dynamic', 'QueryBuilder') and not x['test']:
            dyn_by_fn.setdefault((x['file'], x['fn']), []).append(x)
    builder_sites = []
    unreviewed, stale_types = [], []
    for key, entry in REVIEWED_RUNTIME_SQL.items():
        got = sorted(dyn_by_fn.get(key, []), key=lambda x: x['pos'])
        if len(got) != len(entry['builders']):
            unreviewed.append(('count', key, got, len(entry['builders'])))
            continue
        for bsite, spec in zip(got, entry['builders']):
            builder_sites.append((bsite, spec))
        params = {}
        for spec in entry['builders']:
            params.update(spec.get('params') or {})
        if params:
            # A push_bind names its column; a plain .bind() added out of the
            # chain does not, so it must at least have one of the declared types.
            for bd in loose.get(key, []):
                want = {params.get(bd['col'])} if bd['col'] else set(params.values())
                if pg_type(bd['type']) not in want:
                    stale_types.append((key, bd))
    for key, got in dyn_by_fn.items():
        if key not in REVIEWED_RUNTIME_SQL:
            for x in got:
                unreviewed.append(('new', key, [x], 0))
    for x in unresolved_calls:
        if x['how'] == 'dynamic':
            unreviewed.append(('new', (x['file'], x['fn']), [x], 0))

    builder_hits = 0
    for bsite, spec in builder_sites:
        rx = re.compile(spec['emits'], re.S)
        for text, g in groups.items():
            if not rx.fullmatch(text):
                continue
            builder_hits += 1
            if spec.get('positional'):
                compare(text, [(x, None) for x in g] + [(dict(bsite, how='reviewed builder'), None)])
            else:
                over = {}
                for col, num in re.findall(r'\b([a-z_][a-z0-9_]*)\s*=\s*\$(\d+)', text):
                    if col in spec['params']:
                        over[int(num) - 1] = {'pg': spec['params'][col], 'type': spec['params'][col],
                                              'expr': '%s, per REVIEWED_RUNTIME_SQL' % col}
                compare(text, [(x, None) for x in g] + [(dict(bsite, how='reviewed builder'), over)])

    control = [f for f in found if f[0] == CONTROL_TEXT]
    ok_control = (len(control) == 1 and set(control[0][2]) == {'i32', 'i64'}
                  and [x['fn'] for x, _ in control[0][2]['i64']] == ['binds_i64_late'])
    if not ok_control:
        print('check-sql-bind-types: BROKEN - the planted i32/i64 pair (the i64 fixed only after the bind) '
              'was not reported as exactly that; this check can no longer see a collision.', file=sys.stderr)
        return 2
    found = [f for f in found if f[0] != CONTROL_TEXT]
    text_sites = [x for x in text_sites if x['text'] not in (CONTROL_TEXT, CONTROL_OTHER)]

    # Binds the check cannot see or type, on texts where it matters.
    hidden = [x for x in text_sites if not x['with_args'] and max_param(x['text']) != len(x['binds'])]
    hidden += [x for x in text_sites if x['with_args'] and max_param(x['text'])]
    untyped = [(x, bd) for x in text_sites if len(groups[x['text']]) > 1 or x['text'] in builder_texts
               for bd in x['binds'] if not bd.get('type')]
    for bsite, spec in builder_sites:
        if spec.get('positional'):
            untyped += [(bsite, bd) for bd in bsite['binds'] if not bd.get('type')]
    ambiguous = [x for x in sites + unresolved_calls if x['how'] == 'ambiguous']

    if dump:
        with open(dump, 'w', encoding='utf-8') as fh:
            json.dump([{k: v for k, v in x.items() if k not in ('argspan',)} for x in sites + extra],
                      fh, indent=1, default=str)

    all_binds = [bd for x in sites for bd in x['binds']]
    resolved = sum(1 for x in sites if x['how'] not in ('dynamic', 'ambiguous', 'QueryBuilder'))
    shared = sum(1 for t, g in groups.items() if len(g) > 1 and t not in (CONTROL_TEXT, CONTROL_OTHER))
    print(f'check-sql-bind-types: {len(sites)} query call sites ({resolved} with a known SQL text), '
          f'{len(types)}/{n} binds typed by rustc in {passes} pass(es), {shared} SQL texts shared by 2+ sites, '
          f'{len(builder_sites)} reviewed runtime builders ({builder_hits} static texts they can emit); '
          f'positive control seen.')
    rc = 0
    for text, pos, by in found:
        rc = 1
        print(f'\nMISMATCH at ${pos + 1} of: {" ".join(text.split())[:160]}')
        for t, xs in sorted(by.items()):
            for x, bd in xs:
                tag = ' [test]' if x['test'] else ''
                via = '' if x['how'] in ('static',) else f' [{x["how"]}]'
                print(f'  {t:<10} {x["file"]}:{x["line"]} ({x["fn"]}){tag}{via}  .bind({bd["expr"]}) : {bd["type"]}')
    if found:
        print('\nBind the COLUMN\'s width at every site of a shared text (i32 for INT4, i64 for BIGINT).')
    for x in hidden:
        rc = 1
        print(f'\nBINDS NOT VISIBLE: {x["file"]}:{x["line"]} ({x["fn"]}) runs a text with ${max_param(x["text"])} '
              f'but {len(x["binds"])} .bind() chained onto the call:\n  {" ".join(x["text"].split())[:160]}\n'
              f'  Chain every .bind() onto the sqlx::query*(..) call, so their types can be checked.')
    for x, bd in untyped:
        rc = 1
        print(f'\nUNTYPED bind on a shared text: {x["file"]}:{x["line"]} ({x["fn"]}) .bind({bd["expr"]}) - rustc '
              f'reported no type for it (code compiled out on this platform?).')
    for x in ambiguous:
        rc = 1
        print(f'\nAMBIGUOUS CONST: {x["file"]}:{x["line"]} ({x["fn"]}) query({x["arg"][:80]}) - {x["ambiguous"]}.\n'
              f'  Name it by its module path, or give the consts different names.')
    for kind, key, xs, want in unreviewed:
        rc = 1
        if kind == 'count':
            print(f'\nUNREVIEWED runtime-built SQL: {key[0]} ({key[1]}) has {len(xs)} runtime-built queries; '
                  f'its REVIEWED_RUNTIME_SQL entry describes {want}.')
        for x in xs:
            print(f'\nUNREVIEWED runtime-built SQL: {x["file"]}:{x["line"]} ({x["fn"]}) '
                  f'{"QueryBuilder" if x.get("builder") else "query"}({x["arg"][:80]})')
        print(f'  Its text cannot be resolved statically. Check that no other site can produce the same text\n'
              f'  with different bind types, then describe it in REVIEWED_RUNTIME_SQL[{key!r}]\n'
              f'  (what it can emit, and its parameter types).')
    for key, bd in stale_types:
        rc = 1
        what = f'column {bd["col"]}' if bd['col'] else 'its builder'
        print(f'\nREVIEW OUT OF DATE: {key[0]}:{bd["line"]} ({key[1]}) binds ({bd["expr"]}) : {bd["type"]}, '
              f'not the type its REVIEWED_RUNTIME_SQL entry declares for {what}.')
    untyped_rest = sum(1 for bd in all_binds if not bd.get('type'))
    if untyped_rest:
        print(f'note: {untyped_rest} bind(s) not typed by rustc (none on a shared text unless listed above).')
    if rc == 0:
        print('OK: every shared SQL text is bound with one type per parameter.')
    return rc


if __name__ == '__main__':
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException:
        traceback.print_exc()
        print('check-sql-bind-types: BROKEN - internal error (above); the check proved nothing.', file=sys.stderr)
        sys.exit(2)
