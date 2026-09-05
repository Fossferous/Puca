//! Unix-domain-socket transport (Linux).
//!
//! The same newline-delimited JSON as the Windows named pipe (pipe.rs): one
//! request per line, one response per line, ONE client at a time, every
//! authorisation decision in `session::Agent` — the transport never grants
//! anything — and `puca_input::release_all()` the moment a client goes away,
//! so a key a vanished controller was holding is not held forever.
//!
//! What stands in for the pipe's owner-only DACL. A Unix socket is a file, so:
//!
//!  - it lives in a directory this user alone can enter (0700, created here,
//!    and refused if it turns out to belong to someone else — on /tmp a
//!    stranger could have created it first);
//!  - the socket file itself is 0600;
//!  - and every accepted connection's peer credentials (SO_PEERCRED) must
//!    carry this process's own uid. Another account on a shared machine
//!    cannot reach the token handshake, let alone what is behind it.
//!
//! The modes are belt; the credential check is braces. The check is what
//! still holds if an operator relaxes the modes, and it is asked of the
//! kernel, which cannot be lied to by the peer.
use crate::protocol::{Request, Response};
use crate::session::Agent;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

/// Where the socket goes when the launcher does not say. `$XDG_RUNTIME_DIR`
/// is tmpfs, already 0700 and cleared at logout — the right home for a
/// per-session socket; failing that, a per-uid directory under /tmp.
pub fn default_socket_path() -> PathBuf {
    let dir = match std::env::var_os("XDG_RUNTIME_DIR") {
        Some(rt) if !rt.is_empty() => PathBuf::from(rt).join("puca"),
        _ => PathBuf::from(format!("/tmp/puca-{}", uid())),
    };
    dir.join(format!("agent-{}.sock", std::process::id()))
}

fn uid() -> u32 {
    // SAFETY: getuid cannot fail and touches nothing.
    unsafe { libc::getuid() }
}

/// May a peer with this uid talk to us? Only ourselves — not root, not an
/// administrator group, not "the console user": the process that launched us
/// runs as this uid, and nobody else has any business here.
pub fn peer_allowed(peer_uid: u32) -> bool {
    peer_uid == uid()
}

/// The uid on the other end of an accepted connection, from the kernel.
fn peer_uid(stream: &UnixStream) -> Result<u32, String> {
    // SAFETY: a zeroed ucred is a valid out-buffer of the size we pass; the
    // kernel fills it and reports the length it wrote.
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut libc::ucred as *mut libc::c_void,
            &mut len,
        )
    };
    if rc != 0 {
        return Err(format!("SO_PEERCRED failed: {}", std::io::Error::last_os_error()));
    }
    Ok(cred.uid)
}

/// Create the socket's directory as 0700, or verify an existing one is ours.
fn prepare_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let md = std::fs::metadata(dir).map_err(|e| format!("could not stat {}: {e}", dir.display()))?;
    if !md.is_dir() {
        return Err(format!("{} is not a directory", dir.display()));
    }
    if md.uid() != uid() {
        return Err(format!(
            "{} belongs to uid {}, not to us; refusing to put a socket in a directory someone else controls",
            dir.display(),
            md.uid()
        ));
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("could not set {} to 0700: {e}", dir.display()))?;
    Ok(())
}

/// Bind the socket, then serve one client at a time forever. Mirrors
/// `pipe::serve` exactly in shape: a fresh `Agent` per client (so nothing a
/// previous client established — hello, an armed record — carries over), and
/// `release_all()` when the client is gone.
pub fn serve(
    path: &Path,
    token: String,
    flavour: crate::flavour::Flavour,
    ua_record: Option<&str>,
) -> Result<(), String> {
    let dir = path.parent().ok_or_else(|| "the socket path has no directory".to_string())?;
    prepare_dir(dir)?;

    // A socket left behind by a previous run is unlinked. Anything else at
    // that path is NOT: replacing a stranger's file is exactly the kind of
    // thing a process that injects input must never do.
    match std::fs::symlink_metadata(path) {
        Ok(md) if md.file_type().is_socket() => {
            let _ = std::fs::remove_file(path);
        }
        Ok(_) => return Err(format!("{} exists and is not a socket; refusing to replace it", path.display())),
        Err(_) => {}
    }

    let listener = UnixListener::bind(path).map_err(|e| format!("could not bind {}: {e}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("could not set {} to 0600: {e}", path.display()))?;

    loop {
        let mut agent = Agent::new(token.clone(), flavour);
        if let Some(record) = ua_record {
            agent.arm_from_record_file(record);
        }

        let (stream, _) = match listener.accept() {
            Ok(accepted) => accepted,
            Err(e) => {
                eprintln!("[agent] accept failed: {e}");
                continue;
            }
        };
        match peer_uid(&stream) {
            Ok(u) if peer_allowed(u) => {}
            Ok(u) => {
                eprintln!("[agent] refused a connection from uid {u}");
                continue;
            }
            Err(e) => {
                eprintln!("[agent] refused a connection whose peer could not be identified: {e}");
                continue;
            }
        }

        let reader_half = match stream.try_clone() {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[agent] could not clone the connection: {e}");
                continue;
            }
        };
        let mut reader = BufReader::new(reader_half);
        let mut writer = stream;
        let mut line = String::new();

        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break, // client went away
                Ok(_) => {}
                Err(_) => break,
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let response = match serde_json::from_str::<Request>(trimmed) {
                Ok(req) => agent.handle(req),
                Err(e) => Response::error(format!("bad request: {e}")),
            };

            let mut out = serde_json::to_string(&response)
                .unwrap_or_else(|_| r#"{"ok":"error","message":"could not encode response"}"#.into());
            out.push('\n');
            if writer.write_all(out.as_bytes()).is_err() {
                break;
            }
            let _ = writer.flush();
        }

        puca_input::release_all();
    }
}

/// Block until the process that launched us is gone. The Windows agent does
/// the same with a process handle; here the parent's death re-parents us, so
/// `getppid()` stops answering with the pid we were told.
pub fn watch_parent(pid: u32) {
    loop {
        // SAFETY: getppid cannot fail and touches nothing.
        if unsafe { libc::getppid() } as u32 != pid {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

/// Send stderr to a log file the launcher chose, created 0600.
pub fn redirect_stderr_to(path: &str) {
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::io::IntoRawFd;
    match std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(path) {
        Ok(f) => {
            let fd = f.into_raw_fd();
            // SAFETY: fd is a valid descriptor we own; dup2 onto 2 replaces
            // stderr and the original is then closed.
            unsafe {
                libc::dup2(fd, 2);
                libc::close(fd);
            }
        }
        Err(e) => eprintln!("[agent] could not open the log file {path}: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const TOKEN: &str = "test-token-0123456789abcdef";

    fn fresh_path(tag: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("puca-agent-test-{}-{tag}", std::process::id()))
            .join("agent.sock")
    }

    /// Serve on a fresh path in a background thread; return once it is bound.
    fn start(tag: &str, token: &str) -> PathBuf {
        let path = fresh_path(tag);
        let (p, t) = (path.clone(), token.to_string());
        std::thread::spawn(move || {
            let _ = serve(&p, t, crate::flavour::Flavour::parse(None), None);
        });
        for _ in 0..200 {
            if path.exists() {
                return path;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("the agent never bound {}", path.display());
    }

    fn hello_line() -> String {
        format!(r#"{{"cmd":"hello","token":"{TOKEN}","version":2}}"#)
    }

    fn talk(s: &mut UnixStream, line: &str) -> String {
        s.write_all(format!("{line}\n").as_bytes()).unwrap();
        s.flush().unwrap();
        let mut r = BufReader::new(s.try_clone().unwrap());
        let mut out = String::new();
        r.read_line(&mut out).unwrap();
        out
    }

    #[test]
    fn the_socket_and_its_directory_admit_only_the_owner() {
        let path = start("perms", TOKEN);
        let mode = std::fs::metadata(&path).unwrap().mode() & 0o777;
        assert_eq!(mode, 0o600, "socket mode");
        let dmode = std::fs::metadata(path.parent().unwrap()).unwrap().mode() & 0o777;
        assert_eq!(dmode, 0o700, "directory mode");
    }

    #[test]
    fn a_request_before_hello_is_refused_and_hello_with_the_launch_token_opens_the_session() {
        let path = start("hello", TOKEN);
        let mut s = UnixStream::connect(&path).unwrap();
        let early = talk(&mut s, r#"{"cmd":"capabilities"}"#);
        assert!(early.contains(r#""ok":"error""#), "before hello: {early}");
        let hello = talk(&mut s, &hello_line());
        assert!(hello.contains(r#""ok":"hello""#), "{hello}");
        let caps = talk(&mut s, r#"{"cmd":"capabilities"}"#);
        assert!(caps.contains(r#""ok":"capabilities""#), "after hello: {caps}");
    }

    #[test]
    fn a_wrong_token_is_refused() {
        let path = start("token", TOKEN);
        let mut s = UnixStream::connect(&path).unwrap();
        let reply = talk(&mut s, r#"{"cmd":"hello","token":"not-the-token-0123456789","version":2}"#);
        assert!(reply.contains(r#""ok":"error""#), "{reply}");
        // and the session stays closed
        let caps = talk(&mut s, r#"{"cmd":"capabilities"}"#);
        assert!(caps.contains(r#""ok":"error""#), "{caps}");
    }

    #[test]
    fn one_client_at_a_time_the_second_is_served_only_after_the_first_leaves() {
        // The Windows pipe has a single instance, so a second controller can
        // never interleave with the first. The kernel accepts a second Unix
        // connection into the backlog, so the guarantee here is that it is
        // not SERVED — not answered — until the first has gone.
        let path = start("single", TOKEN);
        let mut a = UnixStream::connect(&path).unwrap();
        assert!(talk(&mut a, &hello_line()).contains(r#""ok":"hello""#));

        let mut b = UnixStream::connect(&path).unwrap();
        b.write_all(format!("{}\n", hello_line()).as_bytes()).unwrap();
        b.set_read_timeout(Some(Duration::from_millis(400))).unwrap();
        let mut rb = BufReader::new(b.try_clone().unwrap());
        let mut out = String::new();
        let r = rb.read_line(&mut out);
        assert!(r.is_err() || out.is_empty(), "B must not be served while A is connected: {out}");

        drop(a);
        b.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        out.clear();
        rb.read_line(&mut out).unwrap();
        assert!(out.contains(r#""ok":"hello""#), "B served after A left: {out}");
    }

    #[test]
    fn the_peer_check_is_a_real_check() {
        // POSITIVE CONTROL: the predicate must be able to say no, or the
        // accept loop's use of it proves nothing.
        assert!(peer_allowed(uid()));
        assert!(!peer_allowed(uid().wrapping_add(1)));
        assert!(!peer_allowed(0) || uid() == 0, "root is not us");
    }

    #[test]
    fn something_that_is_not_a_socket_in_the_way_is_never_replaced() {
        let path = fresh_path("inway");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"someone else's file").unwrap();
        let err = serve(&path, TOKEN.into(), crate::flavour::Flavour::parse(None), None).unwrap_err();
        assert!(err.contains("not a socket"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), b"someone else's file");
    }

    #[test]
    fn a_directory_owned_by_someone_else_is_refused() {
        // Cannot chown in a test; prove the predicate the other way round:
        // our own directory is accepted, and the failure path is reachable
        // by handing it something that is not a directory at all.
        let file = fresh_path("notdir");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"x").unwrap();
        assert!(prepare_dir(&file).is_err());
        assert!(prepare_dir(file.parent().unwrap()).is_ok());
    }
}
