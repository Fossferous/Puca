// Real components on their own props, for light-surfaces-real-browser.mjs: bundled with the real
// stylesheet, so what is measured here is what the app draws. theme-surfaces/skeleton.mjs covers the
// surfaces inline in a large component, and the gate holds the two readings together.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
// The Notes page's order: notes.css first, each component's own after it.
import '../../src/index.css';
import '../../src/App.css';
import '../../src/components/Chat.css';
import '../../src/notes/notes.css';
import { Popover } from '../../src/components/notes/Popover';
import { UndoBar } from '../../src/notes/components/UndoBar';
import { SnoozeControl } from '../../src/components/reminders/SnoozeControl';
import { ScheduleEditor } from '../../src/components/schedule/ScheduleEditor';
import { DrawingCanvas } from '../../src/components/DrawingCanvas';
import { AmountSheet } from '../../src/components/games/GameBits';
import { LinkPreview } from '../../src/components/LinkPreview';
import { DeviceStageTypeText } from '../../src/components/DeviceStageTypeText';
import type { Task } from '../../src/api/tasks';
import '../../src/components/games/GamesView.css';
import '../../src/components/LinkPreview.css';

const NOW = Date.UTC(2026, 10, 3, 12);
const task = {
    id: 1, channel_id: null, list_id: 1, parent_id: null, description: 'Water the plants', is_completed: false,
    position: 0, created_at: new Date(NOW).toISOString(), created_by: 1, attachments: null,
    due_at: new Date(NOW + 3_600_000).toISOString(),
} as unknown as Task;

const nothing = () => {};

const MOUNTS: Record<string, () => React.ReactElement> = {
    '.notes-popover': function PopoverMount() {
        const [anchor, setAnchor] = useState<HTMLElement | null>(null);
        return (
            <>
                <button ref={setAnchor} type="button">Open</button>
                {anchor && (
                    <Popover anchor={anchor} onClose={nothing} label="Show">
                        <h4>Show</h4>
                        <p className="notes-labels-hint">Words in a popover</p>
                    </Popover>
                )}
            </>
        );
    },
    '.notes-undo': () => <UndoBar message="Note deleted" onUndo={nothing} onExpire={nothing} token={1} />,
    '.notes-snooze-menu': () => <SnoozeControl task={task} now={NOW} onSnooze={nothing} />,
    '.sched-dialog': () => <ScheduleEditor task={task} now={NOW} onSave={nothing as never} onClose={nothing} />,
    '.notes-draw': () => <DrawingCanvas onCancel={nothing} onSave={async () => false} />,
    '.games-sheet': () => (
        <AmountSheet
            title="Raise to" value={20} min={10} max={100} step={10}
            presets={[{ label: 'Half', amount: 50 }]}
            confirmLabel={amount => `Raise to ${amount}`}
            onConfirm={nothing} onClose={nothing}
        />
    ),
    '.link-preview-card': () => <LinkPreview content="https://github.com/example/project" />,
    '.device-stage-typetext': () => <div className="device-stage"><DeviceStageTypeText peerName="A computer" onType={nothing} onClose={nothing} /></div>,
};

const container = document.getElementById('root')!;
let root = createRoot(container);
(window as unknown as { __mount: (name: string) => void }).__mount = (name) => {
    root.unmount();
    root = createRoot(container);
    const Mount = MOUNTS[name];
    root.render(<Mount />);
};
(window as unknown as { __mountNames: string[] }).__mountNames = Object.keys(MOUNTS);
