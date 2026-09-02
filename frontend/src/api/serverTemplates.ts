/**
 * What the create-a-server wizard's choices actually DO.
 *
 * Until 0.9.2 the wizard collected a template, an audience and an icon and
 * Chat threw all three away: every server came out with the stock
 * `default` text + voice channels and no icon, whatever was picked. This
 * module is the other half of that promise — a template is a channel set,
 * an icon is uploaded and attached, and "public" is an explicit checkbox
 * that maps to the server's directory listing.
 *
 * Everything here runs AFTER the server exists, best-effort: a failed icon
 * upload or channel create must not undo the server, so failures come back
 * as warnings the caller can show ("finish it in Server Settings") rather
 * than as a thrown error.
 */
import {
    createChannel,
    listChannels,
    updateChannel,
    updateServerSettings,
    type Channel,
} from './servers';
import { uploadFile } from './uploads';

export interface ServerTemplate {
    /** Text channels, in order. The first replaces the stock `default`. */
    text: string[];
    /** Voice channels, in order. The first replaces the stock `default`. */
    voice: string[];
}

/** Keyed by the wizard's template id. `custom` keeps the stock set. */
export const SERVER_TEMPLATES: Record<string, ServerTemplate> = {
    custom: { text: [], voice: [] },
    gaming: { text: ['general', 'looking-for-group', 'clips'], voice: ['Lobby', 'Squad 1', 'Squad 2'] },
    school: { text: ['announcements', 'general', 'homework-help'], voice: ['Study Room', 'Office Hours'] },
    creative: { text: ['general', 'showcase', 'feedback'], voice: ['Studio'] },
    community: { text: ['welcome', 'general', 'events'], voice: ['Lounge'] },
};

export type TemplateOp =
    | { kind: 'rename'; channelId: number; name: string }
    | { kind: 'create'; name: string; channelType: 0 | 1 };

/**
 * The channel edits that turn a freshly created server (stock `default`
 * text + voice, plus AFK) into the template. Pure, so it is testable: the
 * stock channel of each kind is RENAMED to the template's first name (a
 * delete-and-recreate would leave a server with no channel for a moment,
 * and the stock one is where the creator already is), the rest are created.
 * AFK is never touched.
 */
export function planTemplateChannels(templateId: string, existing: Channel[]): TemplateOp[] {
    const t = SERVER_TEMPLATES[templateId];
    if (!t) return [];
    const ops: TemplateOp[] = [];
    for (const [channelType, names] of [[0, t.text], [1, t.voice]] as const) {
        if (names.length === 0) continue;
        const stock = existing.find(c => c.channel_type === channelType && !c.is_afk && c.name === 'default');
        const [first, ...rest] = names;
        if (stock) ops.push({ kind: 'rename', channelId: stock.id, name: first });
        else ops.push({ kind: 'create', name: first, channelType });
        for (const name of rest) ops.push({ kind: 'create', name, channelType });
    }
    return ops;
}

async function applyOps(serverId: string, ops: TemplateOp[]): Promise<void> {
    // Sequential on purpose: `position` is assigned server-side in creation
    // order, so parallel creates would shuffle the template's order.
    for (const op of ops) {
        if (op.kind === 'rename') await updateChannel(op.channelId, { name: op.name });
        else await createChannel(serverId, op.name, op.channelType);
    }
}

export interface FinishServerOptions {
    template: string;
    iconFile: File | null;
    /** List in the public directory. Explicit and off by default — the
     *  audience question alone never publishes anything. */
    isPublic: boolean;
}

/**
 * Apply the wizard's choices to a server that now exists. Returns the steps
 * that failed, in words the wizard can show; an empty array is full success.
 */
export async function finishServerCreation(serverId: string, opts: FinishServerOptions): Promise<string[]> {
    const warnings: string[] = [];

    const settings: { icon_file_id?: string; is_public?: boolean } = {};
    if (opts.iconFile) {
        try {
            const uploaded = await uploadFile(opts.iconFile);
            settings.icon_file_id = uploaded.id;
        } catch {
            warnings.push('The icon could not be uploaded — add it in Server Settings.');
        }
    }
    if (opts.isPublic) settings.is_public = true;
    if (Object.keys(settings).length > 0) {
        try {
            await updateServerSettings(serverId, settings);
        } catch {
            warnings.push(settings.icon_file_id
                ? 'The icon and visibility could not be saved — set them in Server Settings.'
                : 'The server could not be listed publicly — set it in Server Settings.');
        }
    }

    const ops = planTemplateChannels(opts.template, []);
    if (ops.length > 0) {
        try {
            const existing = await listChannels(serverId);
            await applyOps(serverId, planTemplateChannels(opts.template, existing));
        } catch {
            warnings.push('Some template channels could not be created — add them from the channel list.');
        }
    }
    return warnings;
}
