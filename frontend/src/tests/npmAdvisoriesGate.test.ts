/**
 * The JavaScript advisory gate's decision, without the network.
 *
 * The gate replaces `npm audit --audit-level=high || true`, a step that could
 * not fail and therefore went unread while the log drifted from the triage
 * file for two weeks. What is pinned: an untriaged high/critical package
 * BLOCKS; drift within a triaged package and a stale row WARN; moderate
 * findings are not the gate's business; and a registry that cannot be reached
 * warns rather than fails (the one "reason no commit caused" the old step was
 * right about).
 */
import { describe, it, expect } from 'vitest';
import { triage, parseTriage } from '../../scripts/check-npm-advisories.mjs';

const DOC = `
# npm advisories — triage

| Advisory | Package | Path | Ships to users? | Why | Re-evaluate when |
|---|---|---|---|---|---|
| [GHSA-aaaa-bbbb-cccc](https://github.com/advisories/GHSA-aaaa-bbbb-cccc) | \`js-yaml\` | \`eslint → js-yaml\` | no | config from the repo | never |
| [GHSA-1111-2222-3333](https://github.com/advisories/GHSA-1111-2222-3333), [GHSA-4444-5555-6666](https://github.com/advisories/GHSA-4444-5555-6666) | \`tar\` | \`@capacitor/cli → tar\` | no | own assets | never |
`;

function entry(severity: string, ids: string[], isDirect = false) {
    return {
        severity,
        isDirect,
        via: ids.map(id => ({ url: `https://github.com/advisories/${id}` })),
    };
}

describe('parseTriage', () => {
    it('reads every identifier a row names, keyed by the backticked package', () => {
        const rows = parseTriage(DOC);
        expect([...rows.keys()].sort()).toEqual(['js-yaml', 'tar']);
        expect([...rows.get('tar')!].sort()).toEqual(['GHSA-1111-2222-3333', 'GHSA-4444-5555-6666']);
    });
});

describe('triage', () => {
    it('passes when every high/critical package has a row', () => {
        const { failures, warnings } = triage({
            vulnerabilities: {
                'js-yaml': entry('high', ['GHSA-aaaa-bbbb-cccc']),
                tar: entry('high', ['GHSA-1111-2222-3333', 'GHSA-4444-5555-6666']),
            },
        }, DOC);
        expect(failures).toEqual([]);
        expect(warnings).toEqual([]);
    });

    it('BLOCKS on a high/critical package with no row, naming it and its identifiers', () => {
        const { failures } = triage({
            vulnerabilities: {
                'js-yaml': entry('high', ['GHSA-aaaa-bbbb-cccc']),
                tar: entry('high', ['GHSA-1111-2222-3333', 'GHSA-4444-5555-6666']),
                'left-pad': entry('critical', ['GHSA-dead-beef-0000'], true),
            },
        }, DOC);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('left-pad');
        expect(failures[0]).toContain('critical');
        expect(failures[0]).toContain('DIRECT');
        expect(failures[0]).toContain('GHSA-dead-beef-0000');
    });

    it('only WARNS when a triaged package gains identifiers its row does not name', () => {
        const { failures, warnings } = triage({
            vulnerabilities: {
                'js-yaml': entry('high', ['GHSA-aaaa-bbbb-cccc', 'GHSA-new1-new1-new1']),
                tar: entry('high', ['GHSA-1111-2222-3333', 'GHSA-4444-5555-6666']),
            },
        }, DOC);
        expect(failures).toEqual([]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('js-yaml');
        expect(warnings[0]).toContain('GHSA-new1-new1-new1');
    });

    it('WARNS about a row whose package is no longer reported', () => {
        const { failures, warnings } = triage({
            vulnerabilities: {
                'js-yaml': entry('high', ['GHSA-aaaa-bbbb-cccc']),
            },
        }, DOC);
        expect(failures).toEqual([]);
        expect(warnings.some(w => w.startsWith('tar is triaged but no longer reported'))).toBe(true);
    });

    it('ignores moderate and low findings, triaged or not', () => {
        const { failures, warnings } = triage({
            vulnerabilities: {
                'js-yaml': entry('high', ['GHSA-aaaa-bbbb-cccc']),
                tar: entry('high', ['GHSA-1111-2222-3333', 'GHSA-4444-5555-6666']),
                'some-dev-tool': entry('moderate', ['GHSA-modr-modr-modr']),
                'another': entry('low', ['GHSA-lowx-lowx-lowx']),
            },
        }, DOC);
        expect(failures).toEqual([]);
        expect(warnings).toEqual([]);
    });

    it('a registry that cannot be reached is a warning, not a pass and not a failure', () => {
        const { failures, warnings, reported } = triage({ error: { code: 'ENOTFOUND', summary: 'registry unreachable' } }, DOC);
        expect(failures).toEqual([]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('registry unreachable');
        expect(reported.size).toBe(0);
    });
});
