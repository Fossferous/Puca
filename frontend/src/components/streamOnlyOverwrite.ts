import { PERMISSIONS } from '../api/permissionBits';

// The channel overwrite behind "Voice channels this role may stream in"
// (StreamOnlyRoleSection.tsx, docs/STREAM_ONLY.md).

/** The bits an opened voice channel's overwrite allows for the role. */
export const STREAM_ONLY_OPEN_BITS =
    PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.CONNECT | PERMISSIONS.STREAM;

/** Is a voice channel open to a stream-only role, by its overwrite? The
 *  server's rule (permissions.rs stream_only_layer): a role overwrite that
 *  allows Connect. */
export function isOpenedFor(allow: number | undefined): boolean {
    return ((allow ?? 0) & PERMISSIONS.CONNECT) !== 0;
}

/** The overwrite to write when opening (true) or closing (false) a channel,
 *  keeping any other bits the role's overwrite already carries. `null` means
 *  delete it (nothing would be left). */
export function nextOverwrite(
    existing: { allow: number; deny: number } | undefined,
    open: boolean,
): { allow: number; deny: number } | null {
    const allow = existing?.allow ?? 0;
    const deny = existing?.deny ?? 0;
    if (open) {
        return { allow: allow | STREAM_ONLY_OPEN_BITS, deny: deny & ~STREAM_ONLY_OPEN_BITS };
    }
    const left = { allow: allow & ~STREAM_ONLY_OPEN_BITS, deny };
    return left.allow === 0 && left.deny === 0 ? null : left;
}
