/** Pure helper for PrivacyDisclosure, kept out of the component file so
 *  fast-refresh stays happy and it is unit-testable on its own. */

/** Where the published tree lives when the server does not say. */
export const DEFAULT_REPOSITORY = 'https://github.com/Fossferous/Puca';

/** `<repository>/blob/main/docs/PRIVACY.md` for a forge-shaped repository
 *  URL (GET /source names the operator's — a fork's users land on the fork's
 *  copy); a repository that is not one still gets a link to its root, which
 *  is better than a dead one. */
/** The scheme of a server-supplied repository URL, checked before it is ever
 *  put in an `href`. SOURCE_URL is set by whoever runs the server, so an
 *  unvalidated value lets a hostile or compromised deployment point the app's
 *  own source offer anywhere — including a `javascript:` URL, which React
 *  renders with only a console warning. Host is deliberately NOT restricted:
 *  a self-hoster's own Gitea is a legitimate answer, and forcing them upstream
 *  would make the AGPL offer wrong for their modified build. */
export function safeRepositoryUrl(repository: string | null | undefined): string {
    const base = (repository || '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
    return /^https?:\/\/[^\s]+$/i.test(base) ? base : DEFAULT_REPOSITORY;
}

export function privacyDocUrl(repository: string | null | undefined): string {
    const base = safeRepositoryUrl(repository);
    return /^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\//.test(base)
        ? `${base}/blob/main/docs/PRIVACY.md`
        : base;
}
