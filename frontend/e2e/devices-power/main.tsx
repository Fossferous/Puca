/**
 * The REAL Devices page and the app's own question, mounted alone. The PCs on
 * it are stand-ins (fakeDevices.ts, fakeShares.ts) and so is the session
 * layer that reaches them (fakeSession.ts); the cards, the button, the
 * question, powerOff.ts's wording and the app's CSS are the shipped code.
 */
import './fakeSession';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import '../../src/App.css';
import { DevicesView } from '../../src/components/DevicesView';
import { AppDialogs } from '../../src/components/AppDialogs';
import '../../src/mobile.css';

createRoot(document.getElementById('root')!).render(
    <>
        <DevicesView onClose={() => {}} />
        <AppDialogs />
    </>,
);
