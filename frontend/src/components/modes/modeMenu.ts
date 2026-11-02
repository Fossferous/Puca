import type { ContextMenuItem } from '../ContextMenu';
import type { ServerMode, ServerModes } from '../../api/serverModes';

interface ModeMenuOptions {
    data: ServerModes;
    activeModeId: number | null;
    /** The active mode's main voice channel when Call everyone back can reach it. */
    homeName: string | null;
    onSwitch: (modeId: number | null) => void;
    onCallBack: () => void;
    onManage: () => void;
}

/** Call everyone back is on offer: a mode is on, it has a main channel a person can go
 *  to, and this reader holds Move Members. */
export function offersCallBack(data: ServerModes, activeModeId: number | null, homeName: string | null): boolean {
    return activeModeId !== null && data.can_call_back && homeName !== null;
}

/** What the selector's menu offers this reader. */
export function modeMenuItems({ data, activeModeId, homeName, onSwitch, onCallBack, onManage }: ModeMenuOptions): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];
    if (data.can_switch) {
        items.push({
            id: 'mode-off',
            label: 'Off',
            icon: activeModeId === null ? 'check' : undefined,
            onClick: () => onSwitch(null),
        });
        for (const mode of data.modes) {
            items.push({
                id: `mode-${mode.id}`,
                label: mode.name,
                icon: activeModeId === mode.id ? 'check' : undefined,
                onClick: () => onSwitch(mode.id),
            });
        }
    }
    const callBack = offersCallBack(data, activeModeId, homeName);
    if (callBack || data.can_edit) {
        if (items.length > 0) items.push({ id: 'mode-separator', label: '', separator: true });
    }
    if (callBack) {
        items.push({ id: 'mode-call-back', label: `Call everyone to ${homeName}`, icon: 'megaphone', onClick: onCallBack });
    }
    if (data.can_edit) {
        items.push({ id: 'mode-manage', label: 'Manage modes', icon: 'settings', onClick: onManage });
    }
    return items;
}

/** What the start notice's Join goes to: nothing for someone already there. */
export function noticeJoinName(home: { id: number; name: string } | null | undefined, inCallId: number | null | undefined): string | null {
    return home && home.id !== inCallId ? home.name : null;
}

/** The sentence a switch's warning says, or null when nobody would be cut off. */
export function endedCallsWarning(mode: ServerMode | null | undefined, people: number): string | null {
    if (people <= 0) return null;
    const who = people === 1 ? '1 person' : `${people} people`;
    const verb = people === 1 ? 'is' : 'are';
    return `${who} ${verb} in the voice channels of ${mode?.name ?? 'this mode'}. They will be disconnected.`;
}
