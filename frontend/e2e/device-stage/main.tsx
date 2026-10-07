/**
 * The REAL DeviceStage, mounted alone against fakeSession.ts — the host played
 * by the stand-in, everything else (the stage, its menus, the keyboard bar,
 * the zoom maths, the app's global and mobile CSS) the shipped code.
 */
import './fakeSession';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import { DeviceStage } from '../../src/components/DeviceStage';
import '../../src/mobile.css';

const stage = (window as unknown as { __stage: { start(): void } }).__stage;
stage.start();
createRoot(document.getElementById('root')!).render(<DeviceStage />);
