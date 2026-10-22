/**
 * Púca for Steam Deck: Púca's web client in Game Mode (docs/STEAM_DECK.md).
 *
 * Púca runs in a hidden Steam browser view for as long as the plugin is
 * loaded, so calls and notifications keep going while a game is in front.
 * The Quick Access panel drives the call; the /puca route shows the whole
 * app for messages. How the page and the plugin talk: docs/EMBEDDING.md.
 */
import { definePlugin, routerHook } from '@decky/api';
import { staticClasses } from '@decky/ui';
import { controller, FULL_VIEW_ROUTE } from './controller';
import { FullView } from './components/FullView';
import { PucaGlyph } from './components/icons';
import { QuickAccess } from './components/QuickAccess';

type DiagWindow = Window & { __pucaDeckyDiag?: () => unknown };

export default definePlugin(() => {
    routerHook.addRoute(FULL_VIEW_ROUTE, FullView, { exact: true });
    void controller.start();
    // `__pucaDeckyDiag()` in Steam's DevTools (SharedJSContext): what the
    // plugin knows right now, as Púca's own __pucaVoiceDiag does for a call.
    (window as DiagWindow).__pucaDeckyDiag = () => controller.getSnapshot();
    return {
        name: 'Púca',
        titleView: <div className={staticClasses.Title}>Púca</div>,
        content: <QuickAccess />,
        icon: <PucaGlyph />,
        onDismount() {
            delete (window as DiagWindow).__pucaDeckyDiag;
            controller.stop();
            routerHook.removeRoute(FULL_VIEW_ROUTE);
        },
    };
});
