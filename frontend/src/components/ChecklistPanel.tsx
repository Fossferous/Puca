import { ChecklistBody } from './ChecklistBody';
import { ChecklistIcon, CloseIcon } from './Icons';
import './ChecklistPanel.css';

interface ChecklistPanelProps {
    channelId: number;
    isOpen: boolean;
    onClose: () => void;
    /** Resolved permission bits for the channel (Channel.my_permissions);
     *  undefined = all allowed (old backend). */
    myPerms?: number;
    /** Caller's user id, for creator-only task actions. */
    currentUserId?: number;
    /** Attribution: user id → display name. */
    resolveUserName?: (id: number) => string | undefined;
}

/** The side-panel checklist (the Checklist toggle on a normal text channel).
 *  The list body itself lives in the shared ChecklistBody so a checklist
 *  CHANNEL and the server-wide "All checklists" view render the exact same
 *  UI. */
export function ChecklistPanel({ channelId, isOpen, onClose, myPerms, currentUserId, resolveUserName }: ChecklistPanelProps) {
    if (!isOpen) return null;
    return (
        <div className="checklist-panel">
            <div className="checklist-header">
                <h3><ChecklistIcon /> Checklist</h3>
                <button className="checklist-close" onClick={onClose} aria-label="Close checklist"><CloseIcon size={18} /></button>
            </div>
            <ChecklistBody
                channelId={channelId}
                myPerms={myPerms}
                currentUserId={currentUserId}
                resolveUserName={resolveUserName}
            />
        </div>
    );
}
