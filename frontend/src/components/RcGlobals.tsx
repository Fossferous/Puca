/**
 * Every always-mounted remote-control global, behind ONE import specifier.
 *
 * WHY IT EXISTS. App.tsx used to import and mount nine of these directly, with
 * no gate at all — so a build meant to exclude remote control still mounted the
 * whole host-side surface, and every one of those imports was an unconditional
 * edge in the bundler's module graph that kept the code in the artifact.
 *
 * Collapsing them here gives the lite build a single module to swap
 * (RcGlobals.lite.tsx, which renders nothing). Nothing else in App.tsx needs to
 * know remote control exists.
 *
 * DELIBERATELY NOT HERE: UpdateBanner, RecoveryCodeModal and ClipApprovalPrompt
 * are preserved features that happened to sit in the same JSX block. Moving
 * them in would have removed auto-update, recovery-code display and Clips
 * approval from the lite build along with remote control.
 */
import { ServiceUpdateBanner } from './ServiceUpdateBanner';
import { RemoteControlOverlay } from './RemoteControlOverlay';
import { DeviceStage } from './DeviceStage';
import { UnattendedPassphrasePrompt } from './UnattendedPassphrasePrompt';
import { HostConsentPrompt } from './HostConsentPrompt';
import { FileAccessPrompt } from './FileAccessPrompt';
import { HostFilesIndicator } from './HostFilesIndicator';
import { DeviceDownloads } from './DeviceDownloads';
import { DeviceFileBrowser } from './DeviceFileBrowser';
import { RcLeftoversBanner } from './RcLeftoversBanner';

/**
 * Render order matches what App.tsx had, because these overlap on screen and
 * their stacking is positional: the consent prompts must paint above the
 * device stage, and the file browser above both.
 */
export function RcGlobals() {
    return (
        <>
            {/* Also mounted in the LITE stand-in: a leftover remote-access
                service outlives the app that installed it, so BOTH builds must
                be able to tell the user it is there. In the full build it will
                normally report nothing, because service_cmd can remove it
                properly from Settings. */}
            <RcLeftoversBanner />
            <ServiceUpdateBanner />
            <RemoteControlOverlay />
            <DeviceStage />
            <UnattendedPassphrasePrompt />
            <HostConsentPrompt />
            <FileAccessPrompt />
            <HostFilesIndicator />
            <DeviceDownloads />
            <DeviceFileBrowser />
        </>
    );
}
