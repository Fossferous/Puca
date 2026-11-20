//! The two frames the `caret` data channel carries.
//!
//! UNGATED, AND DELIBERATELY SO. This is plain data with no Win32 in it, and
//! `session.rs:106-117` records what happens when plain data is defined inside a
//! `#[cfg(windows)]` module: the Linux build failed outright (E0433) and CI's
//! frontend job went permanently red. Same trap, avoided the same way.
//!
//! WHY A DATA CHANNEL AND NOT `DeviceSignal`. The sealed signal path rides the
//! server's GENERAL rate bucket (`src/ws.rs:1406`, capacity 100, refill 50/s)
//! and shares `sendSigSeq`/`sigQueue` with SDP and ICE, both of which require
//! strictly increasing sequence numbers on both ends. A 10Hz caret stream there
//! would compete with negotiation and be silently dropped over budget. The
//! agent's own data channel is direct, unmetered by the server, and already
//! exists. Do not "simplify" this back onto the signal path.
//!
//! DEGRADATION IS BY DESIGN. An agent that predates this feature never records
//! the channel id, so `ChannelData` on it hits the existing `continue` and the
//! viewer hears nothing; a viewer that predates it never opens the channel, so
//! the agent never samples. Both ends fall back to what 0.8.87 did.

use serde::{Deserialize, Serialize};
use puca_input::caret::CaretSource;
use std::time::{Duration, Instant};

/// The data channel the VIEWER opens for this.
///
/// Named here because both ends must spell it identically and a mismatch fails
/// SILENTLY — str0m opens the stream regardless of the label, so the viewer's
/// `onopen` fires either way and the only symptom is a caret that never arrives.
/// Pinned against `session.ts` by test below.
pub const CHANNEL_NAME: &str = "caret";

/// Viewer -> agent. The ONLY thing this channel accepts.
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum CaretRequest {
    Track { on: bool },
}

/// Agent -> viewer.
///
/// FRACTIONS of the surface the viewer is looking at right now — the only space
/// both ends agree on. The viewer knows its `<video>`'s intrinsic size and
/// nothing about desktop origins, negative coordinates, rotation or the
/// composite's integer step; the agent knows all of those and none of the
/// viewer's letterboxing. Fractions also survive the encoder downscaling the
/// picture, which pixels would not.
///
/// `mon` and `surf` are what make a stale frame recognisable: the data channel is
/// DIRECT while `monitor-active` rides the relay, so their arrival orders are
/// unrelated, and a frame sampled before a monitor switch can land after the
/// viewer learned of it. Without them the camera would fly to a fraction of the
/// wrong screen.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum CaretReport {
    Caret {
        vis: bool,
        /// Absent, not null, when there is no caret: the viewer validates with
        /// `typeof`, and making it distinguish `null` from missing is work for
        /// nothing (the same reason `ServerMessage::ChatMessage` skips its
        /// `message_id`).
        #[serde(skip_serializing_if = "Option::is_none")]
        x: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        y: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        w: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        h: Option<f64>,
        /// Which tier answered — so the viewer can treat a whole-field rect
        /// differently from a real caret rather than guessing from its size.
        #[serde(skip_serializing_if = "Option::is_none")]
        src: Option<&'static str>,
        /// The capture index this fraction is OF (255 = the All-Displays
        /// composite).
        mon: usize,
        /// Surface generation: bumped on every capture rebuild and monitor
        /// commit.
        surf: u64,
        /// Sent-frame counter. Advances only when a frame was actually accepted
        /// by SCTP, so a gap means a drop rather than a suppressed duplicate.
        seq: u64,
        /// Which sampler made this frame: `CARET_REPORT_REV`, on every frame.
        /// Absent from every agent before it existed.
        rev: u32,
    },
}

/// `rev` on every caret frame. 2: Chromium's hidden caret object (MSAA, 0 px
/// wide on the line of the last text box) is reported as no caret
/// (`puca_input::caret::msaa_caret`), so a Chromium window's focus leaving its
/// text always reaches the viewer as `vis:false`. An agent before this (no
/// `rev`) reported that caret as one, and on a surface wider than 2000 px never
/// sent its hide at all (the 1 px width change is under `CARET_EPSILON`), so a
/// viewer cannot tell from such an agent's `msaa` frames that the focus left
/// the text, and keeps its older rule for them
/// (`deviceAutoKeyboard.ts`, `hideMayGoUnheard`). Only ever raised.
pub const CARET_REPORT_REV: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CaretFractions {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The smallest fraction change worth a packet.
///
/// 1/2000 of the surface: about one pixel on a 1920-wide screen, and well under
/// a tenth of a pixel on the phone's ~390px-wide picture — so nothing visible is
/// suppressed, and a caret that is merely BLINKING (the same rect, re-measured
/// ten times a second) costs nothing at all.
pub const CARET_EPSILON: f64 = 0.0005;

/// How long a sample may age before the agent reports "no caret" instead.
///
/// A sampler thread wedged inside a cross-process accessibility call stops
/// publishing, and a viewer panning to where the caret was a second ago is worse
/// than one that stopped following. Equal to the viewer's own first-report
/// fallback window, which is the honest bound.
pub const CARET_STALE_AFTER: Duration = Duration::from_millis(500);

impl CaretReport {
    /// "There is no caret here" — which is also the ACK that this agent
    /// understands the channel at all. The viewer cannot tell an old agent from a
    /// silent one, so one ~50-byte frame on arming is what makes its 500ms
    /// fallback fire only against agents that genuinely predate this.
    pub fn hidden(mon: usize, surf: u64, seq: u64) -> Self {
        Self::Caret {
            vis: false,
            x: None,
            y: None,
            w: None,
            h: None,
            src: None,
            mon,
            surf,
            seq,
            rev: CARET_REPORT_REV,
        }
    }

    pub fn at(f: CaretFractions, src: CaretSource, mon: usize, surf: u64, seq: u64) -> Self {
        Self::Caret {
            vis: true,
            x: Some(f.x),
            y: Some(f.y),
            w: Some(f.w),
            h: Some(f.h),
            src: Some(src.wire()),
            mon,
            surf,
            seq,
            rev: CARET_REPORT_REV,
        }
    }

    /// UTF-8 text bytes, or `None` if serialisation somehow fails — which is not
    /// a reason to end a session over a caret.
    pub fn to_bytes(&self) -> Option<Vec<u8>> {
        serde_json::to_vec(self).ok()
    }

    fn parts(&self) -> (bool, [Option<f64>; 4], Option<&'static str>, usize, u64) {
        match *self {
            Self::Caret { vis, x, y, w, h, src, mon, surf, .. } => (vis, [x, y, w, h], src, mon, surf),
        }
    }
}

/// Is `next` different enough from the last frame that was actually SENT to be
/// worth a packet?
///
/// `seq` is deliberately NOT compared: it is the wire's ordering aid, and the
/// candidate frame carries the next unused value on every pass, so comparing it
/// would make every pass "changed" and defeat the whole dedupe.
///
/// `mon` and `surf` ARE compared: the same caret at the same fractions means
/// something different after a monitor switch, and the viewer needs to be told.
pub fn caret_changed(prev: Option<&CaretReport>, next: &CaretReport) -> bool {
    let Some(prev) = prev else { return true };
    let (pv, pf, ps, pm, psurf) = prev.parts();
    let (nv, nf, ns, nm, nsurf) = next.parts();
    if pv != nv || ps != ns || pm != nm || psurf != nsurf {
        return true;
    }
    pf.iter().zip(nf.iter()).any(|(a, b)| match (a, b) {
        (Some(a), Some(b)) => (a - b).abs() > CARET_EPSILON,
        (None, None) => false,
        _ => true,
    })
}

/// Is this state change worth a LOG LINE, as opposed to a packet?
///
/// Coordinates change on every keystroke; the caret appearing, disappearing,
/// changing tier, or moving to another surface are the events a field report
/// needs. Logging every send would put ten lines a second into the agent log for
/// as long as someone is typing.
pub fn caret_log_worthy(prev: Option<&CaretReport>, next: &CaretReport) -> bool {
    let Some(prev) = prev else { return true };
    let (pv, _, ps, pm, psurf) = prev.parts();
    let (nv, _, ns, nm, nsurf) = next.parts();
    pv != nv || ps != ns || pm != nm || psurf != nsurf
}

pub fn caret_is_stale(measured_at: Instant, now: Instant) -> bool {
    now.duration_since(measured_at) >= CARET_STALE_AFTER
}

/// A `field` rect covering half the surface is a document body, not a text box:
/// aiming a camera at its centre would pan to the middle of a page and then sit
/// there while the caret moves somewhere else entirely.
pub fn field_rect_is_plausible(f: &CaretFractions) -> bool {
    f.h <= 0.5 && f.w <= 0.9
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fr(x: f64, y: f64, w: f64, h: f64) -> CaretFractions {
        CaretFractions { x, y, w, h }
    }

    #[test]
    fn the_track_request_parses_the_wire_shape() {
        assert_eq!(
            serde_json::from_str::<CaretRequest>(r#"{"t":"track","on":true}"#).unwrap(),
            CaretRequest::Track { on: true },
        );
        // POSITIVE CONTROL for the negatives below: `false` really does parse,
        // so a rejection is about the shape and not about this parser refusing
        // everything.
        assert_eq!(
            serde_json::from_str::<CaretRequest>(r#"{"t":"track","on":false}"#).unwrap(),
            CaretRequest::Track { on: false },
        );

        // Missing the field entirely: "track" with no value must not be read as
        // "track on".
        assert!(serde_json::from_str::<CaretRequest>(r#"{"t":"track"}"#).is_err());
        // Case matters, because `rename_all = "lowercase"` is what the viewer
        // writes.
        assert!(serde_json::from_str::<CaretRequest>(r#"{"t":"TRACK","on":true}"#).is_err());
        // THE AGENT MUST NOT ACCEPT ITS OWN OUTBOUND SHAPE AS A COMMAND. Same
        // invariant as `text_does_not_masquerade_as_another_event` in
        // puca-input.
        assert!(serde_json::from_str::<CaretRequest>(r#"{"t":"caret","vis":true}"#).is_err());
        assert!(serde_json::from_str::<CaretRequest>(r#"{"on":true}"#).is_err());
        assert!(serde_json::from_str::<CaretRequest>(r#"{"t":"track","on":1}"#).is_err());
    }

    #[test]
    fn a_caret_report_serialises_the_way_the_viewer_parses_it() {
        let v = serde_json::to_value(CaretReport::at(
            fr(0.5, 0.25, 0.00078125, 0.0132),
            puca_input::caret::CaretSource::Win32,
            0,
            3,
            7,
        ))
        .unwrap();
        assert_eq!(v["t"], "caret");
        assert_eq!(v["vis"], true);
        assert_eq!(v["x"], 0.5);
        assert_eq!(v["y"], 0.25);
        assert_eq!(v["src"], "win32");
        assert_eq!(v["mon"], 0);
        assert_eq!(v["surf"], 3);
        assert_eq!(v["seq"], 7);
        // Every frame says which sampler made it: the viewer's older-host
        // rule (deviceAutoKeyboard.hideMayGoUnheard) keys on its absence.
        assert_eq!(v["rev"], 2);

        let v = serde_json::to_value(CaretReport::hidden(255, 4, 8)).unwrap();
        assert_eq!(v["rev"], 2);
        assert_eq!(v["t"], "caret");
        assert_eq!(v["vis"], false);
        // ABSENT, not null. The viewer's checks are `typeof x === 'number'`, and
        // a null would have to be special-cased on that side for nothing.
        assert!(v.get("x").is_none(), "a hidden report must not carry coordinates");
        assert!(v.get("y").is_none());
        assert!(v.get("w").is_none());
        assert!(v.get("h").is_none());
        assert!(v.get("src").is_none());
        // But the surface identity is still there: this is the frame that tells
        // the viewer which screen has no caret.
        assert_eq!(v["mon"], 255);
        assert_eq!(v["surf"], 4);
    }

    /// The channel label and the two message tags, pinned against the file that
    /// has to agree with them.
    ///
    /// NOT tautological — the trap that made an earlier `include_str!` test in
    /// this repo prove nothing was that it read ITS OWN source and found the
    /// assertions' own literals. This reads the viewer. And the searched strings
    /// are derived from `CHANNEL_NAME`, so renaming the constant without
    /// renaming the TypeScript goes red.
    #[test]
    fn the_viewer_listens_for_exactly_this_channel_and_these_names() {
        let client = include_str!("../../../frontend/src/api/devices/session.ts");
        assert!(
            client.len() > 100_000,
            "that is not the real session.ts ({} bytes) — the path is wrong and every \
             assertion below would be vacuous",
            client.len(),
        );
        // POSITIVE CONTROL: a channel that has been there since long before this
        // feature, proving the file really was read and searched.
        assert!(client.contains("createDataChannel('files'"));

        assert!(
            client.contains(&format!("createDataChannel('{CHANNEL_NAME}'")),
            "the viewer must open the '{CHANNEL_NAME}' channel, or the agent never learns its id",
        );
        assert!(
            client.contains("t: 'track'"),
            "the viewer must send {{t:'track',on:...}} — the only request this channel accepts",
        );
        assert!(
            client.contains(&format!("t === '{CHANNEL_NAME}'")),
            "the viewer must check the report's tag, not trust any bytes on the channel",
        );
        // NEGATIVE CONTROL, and a real invariant: the caret must NOT ride the
        // sealed signal path, whose frames are `{kind: ...}` and which competes
        // with ICE for a 50/s bucket.
        assert!(
            !client.contains("kind: 'caret'"),
            "a caret on the DeviceSignal path would be silently dropped over budget",
        );
    }

    #[test]
    fn only_a_visible_change_costs_a_packet() {
        let src = puca_input::caret::CaretSource::Win32;
        let base = CaretReport::at(fr(0.5, 0.5, 0.00078, 0.0132), src, 0, 1, 1);

        // Nothing sent yet: the first frame always goes.
        assert!(caret_changed(None, &base));
        // Identical state, next pass. POSITIVE CONTROL for every `true` below.
        assert!(!caret_changed(
            Some(&base),
            &CaretReport::at(fr(0.5, 0.5, 0.00078, 0.0132), src, 0, 1, 1)
        ));
        // A different seq alone is NOT a change — the candidate always carries
        // the next unused value, so comparing it would defeat the dedupe.
        assert!(!caret_changed(
            Some(&base),
            &CaretReport::at(fr(0.5, 0.5, 0.00078, 0.0132), src, 0, 1, 99)
        ));

        // Under the epsilon (0.0005), and over it. Hand-derived: 0.0004 < 0.0005
        // < 0.0006.
        assert!(!caret_changed(
            Some(&base),
            &CaretReport::at(fr(0.5004, 0.5, 0.00078, 0.0132), src, 0, 1, 1)
        ));
        assert!(caret_changed(
            Some(&base),
            &CaretReport::at(fr(0.5006, 0.5, 0.00078, 0.0132), src, 0, 1, 1)
        ));
        // Height: a caret that grew (a bigger font) must re-solve the zoom.
        assert!(caret_changed(
            Some(&base),
            &CaretReport::at(fr(0.5, 0.5, 0.00078, 0.0138), src, 0, 1, 1)
        ));
        // The caret went away.
        assert!(caret_changed(Some(&base), &CaretReport::hidden(0, 1, 1)));
        // Same rect, different tier: the viewer treats a field differently.
        assert!(caret_changed(
            Some(&base),
            &CaretReport::at(
                fr(0.5, 0.5, 0.00078, 0.0132),
                puca_input::caret::CaretSource::Msaa,
                0,
                1,
                1
            )
        ));
        // THE STALE-FRAME GUARD: the same fractions on another screen, or after
        // a rebuild, are not the same place.
        assert!(caret_changed(
            Some(&base),
            &CaretReport::at(fr(0.5, 0.5, 0.00078, 0.0132), src, 1, 1, 1)
        ));
        assert!(caret_changed(
            Some(&base),
            &CaretReport::at(fr(0.5, 0.5, 0.00078, 0.0132), src, 0, 2, 1)
        ));
    }

    /// WHY THE VIEWER HAS TO KNOW WHICH SAMPLER IT IS TALKING TO. Chromium's
    /// caret object hides by going from 1 px wide to 0 in place. An agent
    /// whose sampler still reported that as a caret (before 2026-11-20) sent
    /// the hide only when the width alone moved by more than CARET_EPSILON,
    /// so on a surface wider than 2000 px (a 2560 screen, every composite)
    /// it was never sent, and the viewer's own refusal of a 0 px msaa caret
    /// never saw one. This sampler reports the hidden caret as NO caret, and
    /// that always costs a packet. `CARET_REPORT_REV` says which of the two
    /// a frame came from.
    #[test]
    fn chromiums_hide_reaches_the_viewer_only_from_this_sampler() {
        use puca_input::caret::{msaa_caret, CaretSource, MsaaCaret, MSAA_STATE_INVISIBLE};
        let msaa = CaretSource::Msaa;
        // The address bar's caret, 1 px wide and 22 tall, at (400, 1059) of a
        // 2560x1440 screen, then hidden in place.
        let shown = CaretReport::at(fr(400.0 / 2560.0, 1059.0 / 1440.0, 1.0 / 2560.0, 22.0 / 1440.0), msaa, 0, 1, 1);
        let old_hide = CaretReport::at(fr(400.0 / 2560.0, 1059.0 / 1440.0, 0.0, 22.0 / 1440.0), msaa, 0, 1, 2);
        assert!(!caret_changed(Some(&shown), &old_hide), "the old hide on 2560 px: under the epsilon, never sent");
        // CONTROL: on a 1920 px screen the same hide was sent (1/1920 > 0.0005).
        let shown_1920 = CaretReport::at(fr(400.0 / 1920.0, 0.7, 1.0 / 1920.0, 0.02), msaa, 0, 1, 1);
        let hide_1920 = CaretReport::at(fr(400.0 / 1920.0, 0.7, 0.0, 0.02), msaa, 0, 1, 2);
        assert!(caret_changed(Some(&shown_1920), &hide_1920));
        // THIS sampler: Chromium's hidden caret is no caret, and "no caret"
        // is always a packet, whatever the width.
        assert_eq!(msaa_caret((400, 1059, 0, 22), Some(MSAA_STATE_INVISIBLE)), MsaaCaret::Hidden);
        assert!(caret_changed(Some(&shown), &CaretReport::hidden(0, 1, 2)));
        assert!(CARET_REPORT_REV >= 2);
    }

    /// The viewer's half of the revision, read from the file that holds it:
    /// a frame of this revision must be one the viewer counts as reporting
    /// Chromium's hide.
    #[test]
    fn the_viewer_knows_this_revision_reports_chromiums_hide() {
        let viewer = include_str!("../../../frontend/src/components/deviceAutoKeyboard.ts");
        let at = viewer
            .find("export const CARET_REV_HIDDEN_MSAA = ")
            .expect("deviceAutoKeyboard.ts must define CARET_REV_HIDDEN_MSAA");
        let rest = &viewer[at + "export const CARET_REV_HIDDEN_MSAA = ".len()..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        let wanted: u32 = digits.parse().expect("a number");
        assert!(
            CARET_REPORT_REV >= wanted,
            "this agent's frames (rev {CARET_REPORT_REV}) would be read as an older host's (the viewer wants {wanted})",
        );
        let client = include_str!("../../../frontend/src/api/devices/session.ts");
        assert!(client.contains("rev: num(o.rev)"), "session.ts must read `rev` off the frame");
    }

    /// The log must record STATE, not coordinates — ten lines a second for the
    /// length of a typing session is how a log stops being read.
    #[test]
    fn a_moving_caret_is_not_a_log_line_but_a_new_tier_is() {
        let src = puca_input::caret::CaretSource::Win32;
        let base = CaretReport::at(fr(0.5, 0.5, 0.00078, 0.0132), src, 0, 1, 1);
        assert!(caret_log_worthy(None, &base));
        // Moved a long way: a packet, but not a line.
        assert!(!caret_log_worthy(
            Some(&base),
            &CaretReport::at(fr(0.9, 0.1, 0.00078, 0.0132), src, 0, 1, 1)
        ));
        // Appeared / disappeared / changed tier / changed surface.
        assert!(caret_log_worthy(Some(&base), &CaretReport::hidden(0, 1, 1)));
        assert!(caret_log_worthy(
            Some(&base),
            &CaretReport::at(
                fr(0.5, 0.5, 0.00078, 0.0132),
                puca_input::caret::CaretSource::Uia,
                0,
                1,
                1
            )
        ));
        assert!(caret_log_worthy(
            Some(&base),
            &CaretReport::at(fr(0.5, 0.5, 0.00078, 0.0132), src, 0, 2, 1)
        ));
    }

    #[test]
    fn a_stale_sample_stops_the_viewer_following() {
        // Built by ADDING to a base: on Windows an Instant is measured from
        // boot, so subtracting from `now` can panic seconds after one.
        let measured = Instant::now();
        assert!(!caret_is_stale(measured, measured + Duration::from_millis(499)));
        assert!(caret_is_stale(measured, measured + Duration::from_millis(501)));
        // A sample cannot be stale the instant it was taken.
        assert!(!caret_is_stale(measured, measured));
    }

    #[test]
    fn a_document_sized_field_rect_is_not_a_caret() {
        assert!(!field_rect_is_plausible(&fr(0.1, 0.1, 0.2, 0.6)));
        assert!(!field_rect_is_plausible(&fr(0.1, 0.1, 0.95, 0.05)));
        // POSITIVE CONTROL: an ordinary single-line text box passes.
        assert!(field_rect_is_plausible(&fr(0.1, 0.1, 0.2, 0.05)));
        // The boundaries themselves, hand-derived from the rule `h <= 0.5 && w <= 0.9`.
        assert!(field_rect_is_plausible(&fr(0.0, 0.0, 0.9, 0.5)));
        assert!(!field_rect_is_plausible(&fr(0.0, 0.0, 0.9, 0.5001)));
    }
}
