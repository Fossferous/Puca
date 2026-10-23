// Stand-in for api/keyVerification: the peer's identity key comes from the
// test runner (which derived both identities), not from a server lookup.
// What the manager does with it — the pairwise key, the tag, the session key —
// is the real api/e2ee.
export async function resolvePinnedIdentityKey(userId: number): Promise<string | null> {
    return (window as unknown as { __peerKeys?: Record<number, string> }).__peerKeys?.[userId] ?? null;
}
