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

/**
 * Render order matches what App.tsx had, because these overlap on screen and
 * their stacking is positional: the consent prompts must paint above the
 * device stage, and the file browser above both.
 *
 * RcLeftoversBanner is DELIBERATELY NOT HERE — it belongs to the LITE
 * stand-in (RcGlobals.lite.tsx) alone. It was mounted here in 0.8.127 on the
 * assumption it "will normally report nothing" in the full build; that was
 * wrong for exactly the machines that matter: the detection reports the
 * SovereignRemote service whenever it exists, and in the FULL build that
 * service is the user's own, deliberately-enrolled sign-in-screen component,
 * managed from Settings → Devices — not a leftover. Every enrolled machine
 * got a red banner offering to delete its enrolment secrets, and (z 10001
 * over 10000, same top strip) the banner also sat exactly on top of
 * ServiceUpdateBanner, hiding the real "service needs an update" notice the
 * release should have shown. rc_leftovers_status is also variant-gated in
 * Rust now, so remounting this here would still show nothing.
 */
export function RcGlobals() {
    return (
        <>
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
