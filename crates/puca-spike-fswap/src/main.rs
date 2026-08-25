//! SPIKE FSWAP — the blocking gate for the mid-session UAC bridge.
//!
//! THE QUESTION. To bridge a UAC prompt into an already-running remote session
//! without a reconnect, the app-agent must stay the sole WebRTC endpoint while a
//! SECOND process (a SYSTEM helper on the secure desktop) produces the frames.
//! At the moment of the switch the frame source changes from one `H264Encoder`
//! instance to a different instance in a different process, at a possibly
//! different resolution, and the first post-swap frame must be an IDR carrying
//! fresh SPS/PPS. The design hinges on one unproven fact:
//!
//!   Does a live Chrome `RTCPeerConnection` video decoder absorb that swap
//!   cleanly — no decode reset that looks to the user like a reconnect?
//!
//! WHY IT SHOULD, and why "should" is not "does". From the wire's point of view
//! there is ONE RTP stream: one SSRC, one payload type, monotonic sequence and
//! 90 kHz timestamps, all owned by a single `VideoSender`. A mid-stream
//! resolution change at an IDR is exactly what every screen-share and every
//! simulcast layer switch already does, and Chrome handles it natively. The only
//! genuinely novel thing here is that the bytes originate in a different PROCESS
//! — which is invisible to the wire so long as the single `VideoSender` keeps RTP
//! continuity. That is the theory. This binary measures it against a real Chrome.
//!
//! WHAT IT DOES. `fswap` (no args) is the host: it binds a UDP socket, stands up
//! the shipping `puca_rtc::VideoSender`, serves a one-file page that offers
//! a recvonly H.264 transceiver, and streams synthetic frames from an in-process
//! `H264Encoder` at 1280x720. After a few seconds it spawns `fswap --frame-source
//! 1920x1080` (a SEPARATE process), forces a keyframe, and from then on pushes
//! the CHILD's encoded frames into the same `VideoSender`. The page reports
//! `inbound-rtp` stats and every change to `video.videoWidth`x`videoHeight`.
//!
//! PASS = across the swap: `framesDecoded` keeps climbing, `frameWidth/Height`
//! moves 1280x720 -> 1920x1080, `iceConnectionState` never leaves connected (no
//! restart), and `freezeCount` does not jump. FAIL = a freeze, a stall, an ICE
//! restart, or the picture never changing resolution — any of which means the
//! bridge needs the degraded second-full-session fallback instead.
//!
//! Windows-only: `puca-encode` is Media Foundation.

#[cfg(not(windows))]
fn main() {
    eprintln!("spike-fswap is Windows-only: it needs the Media Foundation H.264 encoder.");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--frame-source") {
        let dims = args.get(i + 1).map(String::as_str).unwrap_or("1920x1080");
        win::run_frame_source(dims);
    } else {
        win::run_host();
    }
}

#[cfg(windows)]
mod win {
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream, UdpSocket};
    use std::process::{Command, Stdio};
    use std::sync::mpsc::{self, Sender};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use puca_encode::{EncodeError, EncodedFrame, FrameCodec, H264Encoder, H264Profile};
    use puca_rtc::VideoSender;
    use str0m::net::{Protocol, Receive};
    use str0m::{Input, Output};

    const HTTP_PORT: u16 = 8791;
    const RES_A: (u32, u32) = (1280, 720);
    const RES_B: (u32, u32) = (1920, 1080);
    const FPS: u32 = 30;
    const BITRATE: u32 = 6_000_000; // bits/sec
    const FRAME_INTERVAL: Duration = Duration::from_millis(33);
    /// Stream from source A this long after the FIRST frame reaches the wire,
    /// then swap. Long enough that the page is visibly settled on 720p first.
    const SWAP_AFTER: Duration = Duration::from_secs(6);

    // ---------- shared host state, read by the /state endpoint ----------

    #[derive(Default)]
    struct HostState {
        answered: bool,
        profile_idc: Option<u8>,
        ice: String,
        frames_sent: u64,
        source: &'static str,
        swapped: bool,
        swap_at_frame: Option<u64>,
        last_err: Option<String>,
    }

    impl HostState {
        fn json(&self) -> String {
            format!(
                "{{\"answered\":{},\"profile_idc\":{},\"ice\":\"{}\",\"frames_sent\":{},\
                 \"source\":\"{}\",\"swapped\":{},\"swap_at_frame\":{},\"last_err\":{}}}",
                self.answered,
                self.profile_idc.map(|p| p.to_string()).unwrap_or_else(|| "null".into()),
                self.ice,
                self.frames_sent,
                self.source,
                self.swapped,
                self.swap_at_frame.map(|f| f.to_string()).unwrap_or_else(|| "null".into()),
                self.last_err
                    .as_ref()
                    .map(|e| format!("\"{}\"", e.replace('"', "'")))
                    .unwrap_or_else(|| "null".into()),
            )
        }
    }

    // ---------- synthetic frame: real changing content, distinct per source ----------

    /// A BGRA frame that (a) changes every frame so `framesDecoded` climbs for a
    /// real reason, and (b) is obviously different between source A and B so a
    /// screenshot alone shows the switch. A = deep blue, B = deep green, each with
    /// a white bar sweeping across (liveness) and a colour-cycling block.
    fn synth_bgra(w: u32, h: u32, frame: u64, source_b: bool) -> Vec<u8> {
        let (wu, hu) = (w as usize, h as usize);
        let mut buf = vec![0u8; wu * hu * 4];
        let (br, bg, bb) = if source_b { (16u8, 110u8, 40u8) } else { (30u8, 40u8, 130u8) };
        for px in buf.chunks_exact_mut(4) {
            px[0] = bb;
            px[1] = bg;
            px[2] = br;
            px[3] = 255;
        }
        // Sweeping white bar.
        let bar = (frame as usize * 9) % wu;
        for y in 0..hu {
            for dx in 0..8 {
                let x = (bar + dx) % wu;
                let o = (y * wu + x) * 4;
                buf[o] = 255;
                buf[o + 1] = 255;
                buf[o + 2] = 255;
            }
        }
        // Colour-cycling block, top-left quadrant, so even a static screenshot has
        // detail and the encoder has something non-trivial to compress.
        let cyc = (frame % 255) as u8;
        let (bw, bh) = (wu / 3, hu / 3);
        for y in (hu / 8)..(hu / 8 + bh).min(hu) {
            for x in (wu / 8)..(wu / 8 + bw).min(wu) {
                let o = (y * wu + x) * 4;
                buf[o] = cyc;
                buf[o + 1] = 255 - cyc;
                buf[o + 2] = if source_b { 200 } else { 80 };
            }
        }
        buf
    }

    fn pace(next: &mut Instant) {
        let now = Instant::now();
        if *next > now {
            std::thread::sleep(*next - now);
        }
        *next = Instant::now() + FRAME_INTERVAL;
    }

    // ---------- child: the "second process" that produces the post-swap frames ----------

    /// Encodes source-B frames and writes them length-framed to stdout:
    /// `[u32 LE payload_len][u8 keyframe][payload]`. Exits cleanly when the parent
    /// closes the pipe (a write error) — that is the teardown path in miniature.
    pub fn run_frame_source(dims: &str) {
        let (w, h) = parse_dims(dims).unwrap_or(RES_B);
        let mut enc = match H264Encoder::new_with_profile(w, h, FPS, BITRATE, H264Profile::High) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[child] encoder init failed: {e}");
                std::process::exit(3);
            }
        };
        eprintln!("[child] frame-source up at {w}x{h}");
        let stdout = std::io::stdout();
        let mut out = stdout.lock();
        let mut frame = 0u64;
        let mut first = true;
        let mut next = Instant::now();
        loop {
            let bgra = synth_bgra(w, h, frame, true);
            match enc.encode_bgra(&bgra, (w * 4) as usize, first) {
                Ok(f) => {
                    first = false;
                    let len = f.data.len() as u32;
                    let key = u8::from(f.keyframe);
                    if out.write_all(&len.to_le_bytes()).is_err()
                        || out.write_all(&[key]).is_err()
                        || out.write_all(&f.data).is_err()
                        || out.flush().is_err()
                    {
                        eprintln!("[child] parent closed the pipe; exiting");
                        return;
                    }
                }
                Err(EncodeError::NeedMoreInput) => {}
                Err(e) => {
                    eprintln!("[child] encode error: {e}");
                    return;
                }
            }
            frame += 1;
            pace(&mut next);
        }
    }

    fn parse_dims(s: &str) -> Option<(u32, u32)> {
        let (a, b) = s.split_once('x')?;
        Some((a.parse().ok()?, b.parse().ok()?))
    }

    // ---------- host: VideoSender + signalling + frame pump + the swap ----------

    pub fn run_host() {
        let socket = UdpSocket::bind("127.0.0.1:0").expect("bind udp");
        let my_addr = socket.local_addr().expect("local addr");
        eprintln!("[host] udp bound at {my_addr}");

        let mut sender = VideoSender::new();
        sender.add_local_candidate(my_addr).expect("add local candidate");

        let state = Arc::new(Mutex::new(HostState::default()));
        let (offer_tx, offer_rx) = mpsc::channel::<(String, Sender<String>)>();
        let cands: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

        spawn_http(state.clone(), offer_tx, cands.clone());
        eprintln!("[host] open http://127.0.0.1:{HTTP_PORT}/ in the browser pane");

        let child_frames: Arc<Mutex<VecDeque<EncodedFrame>>> = Arc::new(Mutex::new(VecDeque::new()));
        let mut enc_a: Option<H264Encoder> = None;
        let mut want_keyframe = false;
        let mut ice_connected = false;
        let mut swapped = false;
        let mut swap_pending = false;
        let mut first_frame_at: Option<Instant> = None;
        let mut fcount: u64 = 0;
        let mut next_frame = Instant::now();
        let mut buf = [0u8; 4096];

        loop {
            // 1. Answer a pending offer (produced on the http thread).
            if let Ok((offer, resp)) = offer_rx.try_recv() {
                match sender.accept_offer(&offer) {
                    Ok(answer) => {
                        let idc = sender.negotiated_h264_profile_idc();
                        {
                            let mut s = state.lock().unwrap();
                            s.answered = true;
                            s.profile_idc = idc;
                        }
                        eprintln!(
                            "[host] answered; h264={} profile_idc={:?}",
                            sender.negotiated_h264(),
                            idc
                        );
                        let _ = resp.send(answer);
                    }
                    Err(e) => {
                        eprintln!("[host] accept_offer failed: {e}");
                        let _ = resp.send(format!("ERROR {e}"));
                    }
                }
            }

            // 2. Fold in any candidates the browser trickled (mDNS .local ones
            //    fail to parse and are skipped — ICE still nominates via the
            //    peer-reflexive address str0m learns from inbound STUN).
            {
                let mut c = cands.lock().unwrap();
                for cand in c.drain(..) {
                    if let Err(e) = sender.add_remote_candidate(&cand) {
                        eprintln!("[host] skip remote candidate ({e})");
                    }
                }
            }

            // 3. Drain str0m outputs.
            let timeout = loop {
                match sender.rtc_mut().poll_output() {
                    Ok(Output::Transmit(t)) => {
                        let _ = socket.send_to(&t.contents, t.destination);
                    }
                    Ok(Output::Event(ev)) => match ev {
                        str0m::Event::IceConnectionStateChange(st) => {
                            let label = format!("{st:?}");
                            eprintln!("[host] ice -> {label}");
                            let connected = matches!(
                                st,
                                str0m::IceConnectionState::Connected
                                    | str0m::IceConnectionState::Completed
                            );
                            if connected {
                                ice_connected = true;
                            }
                            state.lock().unwrap().ice = label;
                        }
                        str0m::Event::KeyframeRequest(_) => {
                            want_keyframe = true;
                        }
                        _ => {}
                    },
                    Ok(Output::Timeout(t)) => break t,
                    Err(e) => {
                        eprintln!("[host] poll_output error: {e}");
                        state.lock().unwrap().last_err = Some(e.to_string());
                        return;
                    }
                }
            };

            // 4. Frame pump, paced to ~30fps, only once media can flow.
            if ice_connected && sender.is_connected() && Instant::now() >= next_frame {
                // Kick off the swap once source A has been on the wire long
                // enough: spawn the child but KEEP streaming source A until the
                // child's first IDR is in hand. That gap-free cutover is exactly
                // the handoff discipline the real bridge needs — the app-agent
                // keeps feeding the session until the SYSTEM helper's first
                // keyframe is ready, so the viewer never sees a stall.
                if !swapped && !swap_pending {
                    if first_frame_at.map_or(false, |t| t.elapsed() >= SWAP_AFTER) {
                        match Command::new(std::env::current_exe().unwrap())
                            .arg("--frame-source")
                            .arg(format!("{}x{}", RES_B.0, RES_B.1))
                            .stdout(Stdio::piped())
                            .stderr(Stdio::inherit())
                            .spawn()
                        {
                            Ok(mut child) => {
                                let out = child.stdout.take().unwrap();
                                spawn_child_reader(out, child_frames.clone());
                                swap_pending = true;
                                eprintln!("[host] child spawned; holding source A until its first IDR");
                                std::mem::forget(child);
                            }
                            Err(e) => {
                                eprintln!("[host] could not spawn child: {e}");
                                state.lock().unwrap().last_err = Some(format!("spawn: {e}"));
                                swapped = true; // do not retry every tick
                            }
                        }
                    }
                }

                let frame: Option<EncodedFrame> = if swapped {
                    child_frames.lock().unwrap().pop_front()
                } else if swap_pending {
                    // Cut over the instant the child's first keyframe is queued.
                    match take_from_first_keyframe(&child_frames) {
                        Some(kf) => {
                            swapped = true;
                            swap_pending = false;
                            {
                                let mut s = state.lock().unwrap();
                                s.swapped = true;
                                s.source = "child-1920x1080";
                                s.swap_at_frame = Some(fcount);
                            }
                            eprintln!("[host] === SWAP: child IDR in hand, cutting over to {}x{} ===", RES_B.0, RES_B.1);
                            Some(kf)
                        }
                        None => source_a_frame(&mut enc_a, fcount, &mut want_keyframe, &state),
                    }
                } else {
                    source_a_frame(&mut enc_a, fcount, &mut want_keyframe, &state)
                };

                if let Some(f) = frame {
                    match sender.send_frame(&f, Instant::now()) {
                        Ok(true) => {
                            if first_frame_at.is_none() {
                                first_frame_at = Some(Instant::now());
                                eprintln!("[host] first frame on the wire");
                            }
                            let mut s = state.lock().unwrap();
                            s.frames_sent += 1;
                            if !s.swapped {
                                s.source = "host-1280x720";
                            }
                        }
                        Ok(false) => {}
                        Err(e) => eprintln!("[host] send_frame error: {e}"),
                    }
                }
                fcount += 1;
                next_frame = Instant::now() + FRAME_INTERVAL;
            }

            // 5. Pump the socket: block until the next str0m timeout or the next
            //    frame is due, whichever is sooner.
            let now = Instant::now();
            let wait = timeout
                .saturating_duration_since(now)
                .min(next_frame.saturating_duration_since(now))
                .max(Duration::from_millis(1));
            let _ = socket.set_read_timeout(Some(wait));
            match socket.recv_from(&mut buf) {
                Ok((n, source)) => {
                    if let Ok(recv) = Receive::new(Protocol::Udp, source, my_addr, &buf[..n]) {
                        if let Err(e) =
                            sender.rtc_mut().handle_input(Input::Receive(Instant::now(), recv))
                        {
                            eprintln!("[host] handle_input(receive) error: {e}");
                        }
                    }
                }
                Err(_) => {
                    if let Err(e) = sender.rtc_mut().handle_input(Input::Timeout(Instant::now())) {
                        eprintln!("[host] handle_input(timeout) error: {e}");
                    }
                }
            }

            if !sender.rtc_mut().is_alive() {
                eprintln!("[host] rtc no longer alive; exiting");
                return;
            }
        }
    }

    /// Produce one source-A (in-process, 1280x720) encoded frame, or None on a
    /// startup `NeedMoreInput`.
    fn source_a_frame(
        enc_a: &mut Option<H264Encoder>,
        fcount: u64,
        want_keyframe: &mut bool,
        state: &Arc<Mutex<HostState>>,
    ) -> Option<EncodedFrame> {
        if enc_a.is_none() {
            match H264Encoder::new_with_profile(RES_A.0, RES_A.1, FPS, BITRATE, H264Profile::High) {
                Ok(e) => *enc_a = Some(e),
                Err(e) => {
                    eprintln!("[host] source-A encoder init failed: {e}");
                    state.lock().unwrap().last_err = Some(e.to_string());
                    return None;
                }
            }
        }
        let bgra = synth_bgra(RES_A.0, RES_A.1, fcount, false);
        let force = std::mem::take(want_keyframe);
        match enc_a.as_mut().unwrap().encode_bgra(&bgra, (RES_A.0 * 4) as usize, force) {
            Ok(f) => Some(f),
            Err(EncodeError::NeedMoreInput) => None,
            Err(e) => {
                eprintln!("[host] source-A encode error: {e}");
                None
            }
        }
    }

    /// If the queue holds a keyframe, drop everything before it and return it;
    /// otherwise None. This is the cutover: the app-agent keeps streaming its own
    /// source until the helper's first IDR is in hand, so the switch has no gap.
    fn take_from_first_keyframe(q: &Arc<Mutex<VecDeque<EncodedFrame>>>) -> Option<EncodedFrame> {
        let mut q = q.lock().unwrap();
        let idx = q.iter().position(|f| f.keyframe)?;
        for _ in 0..idx {
            q.pop_front();
        }
        q.pop_front()
    }

    /// Read length-framed encoded frames from the child's stdout and queue them.
    fn spawn_child_reader(
        mut out: std::process::ChildStdout,
        queue: Arc<Mutex<VecDeque<EncodedFrame>>>,
    ) {
        std::thread::spawn(move || {
            let mut hdr = [0u8; 5];
            loop {
                if out.read_exact(&mut hdr).is_err() {
                    eprintln!("[host] child stream ended");
                    return;
                }
                let len = u32::from_le_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as usize;
                let keyframe = hdr[4] != 0;
                let mut data = vec![0u8; len];
                if out.read_exact(&mut data).is_err() {
                    eprintln!("[host] child stream truncated");
                    return;
                }
                let mut q = queue.lock().unwrap();
                // Bound the queue: if the consumer ever falls behind, drop the
                // oldest deltas rather than grow without limit. Never drop a
                // keyframe.
                if q.len() > 90 {
                    while q.len() > 30 {
                        if q.front().map(|f| f.keyframe).unwrap_or(false) {
                            break;
                        }
                        q.pop_front();
                    }
                }
                q.push_back(EncodedFrame { data, keyframe, codec: FrameCodec::H264 });
            }
        });
    }

    // ---------- a minimal same-origin signalling server ----------

    fn spawn_http(
        state: Arc<Mutex<HostState>>,
        offer_tx: Sender<(String, Sender<String>)>,
        cands: Arc<Mutex<Vec<String>>>,
    ) {
        std::thread::spawn(move || {
            let listener = match TcpListener::bind(("127.0.0.1", HTTP_PORT)) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[http] bind {HTTP_PORT} failed: {e}");
                    return;
                }
            };
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let state = state.clone();
                let offer_tx = offer_tx.clone();
                let cands = cands.clone();
                std::thread::spawn(move || handle_conn(stream, state, offer_tx, cands));
            }
        });
    }

    fn handle_conn(
        mut stream: TcpStream,
        state: Arc<Mutex<HostState>>,
        offer_tx: Sender<(String, Sender<String>)>,
        cands: Arc<Mutex<Vec<String>>>,
    ) {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 4096];
        // Read headers (and any body already arrived) until we have the full
        // request. Bounded, single-shot: fine for localhost fetch.
        let (head_end, content_len) = loop {
            match stream.read(&mut tmp) {
                Ok(0) => return,
                Ok(n) => {
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(pos) = find_headers_end(&buf) {
                        let cl = content_length(&buf[..pos]);
                        break (pos, cl);
                    }
                    if buf.len() > 1 << 20 {
                        return;
                    }
                }
                Err(_) => return,
            }
        };
        let body_start = head_end + 4;
        while buf.len() < body_start + content_len {
            match stream.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => buf.extend_from_slice(&tmp[..n]),
                Err(_) => break,
            }
        }
        let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
        let body = String::from_utf8_lossy(&buf[body_start..(body_start + content_len).min(buf.len())]).to_string();
        let mut lines = head.lines();
        let req = lines.next().unwrap_or("");
        let mut parts = req.split_whitespace();
        let method = parts.next().unwrap_or("");
        let path = parts.next().unwrap_or("");

        match (method, path) {
            ("GET", "/") => respond(&mut stream, "200 OK", "text/html; charset=utf-8", PAGE.as_bytes()),
            ("GET", "/state") => {
                let json = state.lock().unwrap().json();
                respond(&mut stream, "200 OK", "application/json", json.as_bytes());
            }
            ("POST", "/offer") => {
                let (tx, rx) = mpsc::channel::<String>();
                if offer_tx.send((body, tx)).is_err() {
                    respond(&mut stream, "500 Internal Server Error", "text/plain", b"host gone");
                    return;
                }
                match rx.recv_timeout(Duration::from_secs(5)) {
                    Ok(answer) => respond(&mut stream, "200 OK", "application/sdp", answer.as_bytes()),
                    Err(_) => respond(&mut stream, "504 Gateway Timeout", "text/plain", b"no answer"),
                }
            }
            ("POST", "/candidate") => {
                if !body.trim().is_empty() {
                    cands.lock().unwrap().push(body);
                }
                respond(&mut stream, "200 OK", "text/plain", b"ok");
            }
            _ => respond(&mut stream, "404 Not Found", "text/plain", b"nope"),
        }
    }

    fn find_headers_end(buf: &[u8]) -> Option<usize> {
        buf.windows(4).position(|w| w == b"\r\n\r\n")
    }

    fn content_length(head: &[u8]) -> usize {
        let head = String::from_utf8_lossy(head);
        for line in head.lines() {
            if let Some(v) = line.strip_prefix("Content-Length:").or_else(|| line.strip_prefix("content-length:")) {
                return v.trim().parse().unwrap_or(0);
            }
        }
        0
    }

    fn respond(stream: &mut TcpStream, status: &str, ctype: &str, body: &[u8]) {
        let header = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(header.as_bytes());
        let _ = stream.write_all(body);
        let _ = stream.flush();
    }

    const PAGE: &str = r#"<!doctype html>
<meta charset="utf-8">
<title>fswap spike</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 0; background:#111; color:#eee; }
  #wrap { display:flex; gap:12px; padding:12px; }
  video { background:#000; width:640px; height:auto; border:1px solid #444; }
  #side { flex:1; }
  pre { background:#000; padding:8px; border:1px solid #333; white-space:pre-wrap; max-height:70vh; overflow:auto; }
  .big { font-size:20px; font-weight:bold; }
  #dim { color:#6cf; }
</style>
<div id="wrap">
  <video id="v" autoplay muted playsinline></video>
  <div id="side">
    <div class="big">fswap: mid-stream frame-source swap</div>
    <div>video dimension: <span id="dim" class="big">-</span></div>
    <div>ice: <span id="ice">-</span></div>
    <h4>inbound-rtp</h4>
    <pre id="stats">waiting…</pre>
    <h4>event log</h4>
    <pre id="log"></pre>
  </div>
</div>
<script>
const v = document.getElementById('v');
const logEl = document.getElementById('log');
const t0 = performance.now();
function log(m){ const t=((performance.now()-t0)/1000).toFixed(2); logEl.textContent += `[${t}s] ${m}\n`; }
const pc = new RTCPeerConnection({ iceServers: [] });
pc.addTransceiver('video', { direction: 'recvonly' });
pc.ontrack = e => { v.srcObject = e.streams[0]; log('ontrack: media attached'); };
pc.oniceconnectionstatechange = () => { document.getElementById('ice').textContent = pc.iceConnectionState; log('ice ' + pc.iceConnectionState); };
let lastDim = '';
let lastFreeze = 0;
async function start(){
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await new Promise(r => {
    if (pc.iceGatheringState === 'complete') return r();
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') r(); };
  });
  log('posting offer (' + pc.localDescription.sdp.length + ' bytes)');
  const ans = await (await fetch('/offer', { method:'POST', body: pc.localDescription.sdp })).text();
  if (ans.startsWith('ERROR')) { log('offer rejected: ' + ans); return; }
  await pc.setRemoteDescription({ type:'answer', sdp: ans });
  log('answer applied');
  setInterval(poll, 500);
}
async function poll(){
  const dim = v.videoWidth + 'x' + v.videoHeight;
  document.getElementById('dim').textContent = dim;
  if (dim !== lastDim && v.videoWidth > 0) { log('VIDEO DIMENSION -> ' + dim); lastDim = dim; }
  const stats = await pc.getStats();
  stats.forEach(r => {
    if (r.type === 'inbound-rtp' && r.kind === 'video') {
      if ((r.freezeCount || 0) !== lastFreeze) {
        log('FREEZE count -> ' + r.freezeCount + ' (total ' + (r.totalFreezesDuration || 0).toFixed(3) + 's)');
        lastFreeze = r.freezeCount || 0;
      }
      document.getElementById('stats').textContent = JSON.stringify({
        framesReceived: r.framesReceived, framesDecoded: r.framesDecoded,
        keyFramesDecoded: r.keyFramesDecoded, framesDropped: r.framesDropped,
        frameWidth: r.frameWidth, frameHeight: r.frameHeight,
        freezeCount: r.freezeCount, totalFreezesDuration: r.totalFreezesDuration,
        pauseCount: r.pauseCount, pliCount: r.pliCount, firCount: r.firCount,
      }, null, 1);
    }
  });
}
start().catch(e => log('start failed: ' + e));
</script>
"#;
}
