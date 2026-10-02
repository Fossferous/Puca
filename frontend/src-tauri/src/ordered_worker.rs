//! One thread, one FIFO: work handed off a thread that must never wait, in
//! the exact order it was handed off.
//!
//! WHY THIS EXISTS. A synchronous `#[tauri::command]` runs inline in the IPC
//! handler — on Windows that is the MAIN (UI) thread, the same thread that
//! runs the tray menu's modal loop, paints, and dispatches every other
//! command. Anything that can wait there (a thread join, a bounded sleep, an
//! acknowledgement from another worker) stalls the whole window for as long
//! as it waits. Making such a command `async` moves the work off the main
//! thread but adds REORDERING: each async invoke becomes its own task on a
//! thread pool, so a stop can overtake the start delivered before it. A sync
//! command that only does `send` here avoids both: the send happens on the
//! main thread in the order the IPC layer delivers the invokes and never
//! waits (an unbounded channel append), and the work runs on one dedicated
//! thread in that same order.
//!
//! What this cannot fix: the IPC layer does not promise to deliver two
//! separate invokes in the order JS issued them. Work whose order matters
//! across invokes must travel in ONE invoke (`inject_input_batch`).

/// A named worker thread consuming jobs strictly in the order `send` was
/// called. Dropping the worker closes the queue; the thread drains what was
/// already queued and exits.
pub(crate) struct OrderedWorker<J: Send + 'static> {
    tx: std::sync::mpsc::Sender<J>,
}

impl<J: Send + 'static> OrderedWorker<J> {
    /// Start the worker. If the OS refuses the thread, every `send` reports
    /// the worker gone rather than silently queueing into nothing.
    pub fn spawn(name: &str, mut consume: impl FnMut(J) + Send + 'static) -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<J>();
        let spawned = std::thread::Builder::new().name(name.to_string()).spawn(move || {
            for job in rx {
                consume(job);
            }
        });
        if let Err(e) = spawned {
            log::error!("[worker] could not start the {name} thread: {e}");
        }
        Self { tx }
    }

    /// Queue `job` behind everything queued before it. Never waits for the
    /// worker: this is safe to call from the UI thread whatever the worker is
    /// doing. `Err` hands the job back when the worker is gone.
    pub fn send(&self, job: J) -> Result<(), J> {
        self.tx.send(job).map_err(|e| e.0)
    }
}

#[cfg(test)]
mod tests {
    use super::OrderedWorker;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn jobs_run_in_the_order_they_were_sent() {
        let (out_tx, out_rx) = mpsc::channel();
        let w = OrderedWorker::spawn("test-order", move |n: u32| {
            // Uneven work per job: a pool would let a short job overtake.
            if n % 3 == 0 {
                std::thread::sleep(Duration::from_millis(2));
            }
            let _ = out_tx.send(n);
        });
        for n in 0..50 {
            w.send(n).unwrap();
        }
        let got: Vec<u32> = (0..50).map(|_| out_rx.recv_timeout(Duration::from_secs(5)).unwrap()).collect();
        assert_eq!(got, (0..50).collect::<Vec<_>>());
    }

    /// THE PROPERTY THE UI THREAD NEEDS: `send` returns while the worker is
    /// still stuck on an earlier job. Deterministic, not timing-based: the
    /// stuck job only proceeds when the gate opens, and the gate is opened by
    /// this thread AFTER every send has returned — a send that waited for the
    /// worker would wait out the whole gate timeout and the job would record
    /// that it was never released.
    #[test]
    fn send_never_waits_for_a_stuck_worker() {
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        let (out_tx, out_rx) = mpsc::channel::<(u32, bool)>();
        let w = OrderedWorker::spawn("test-stuck", move |n: u32| {
            let released = if n == 0 {
                gate_rx.recv_timeout(Duration::from_secs(3)).is_ok()
            } else {
                true
            };
            let _ = out_tx.send((n, released));
        });
        for n in 0..10 {
            w.send(n).unwrap();
        }
        // Every send above has returned. Only now may job 0 continue.
        gate_tx.send(()).unwrap();
        let first = out_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(first, (0, true), "job 0 must have been released by the gate, not timed out: send waited for the worker");
    }

    #[test]
    fn jobs_run_on_the_worker_thread_not_the_caller() {
        let (out_tx, out_rx) = mpsc::channel();
        let w = OrderedWorker::spawn("test-thread", move |_: ()| {
            let _ = out_tx.send(std::thread::current().id());
        });
        w.send(()).unwrap();
        let ran_on = out_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_ne!(ran_on, std::thread::current().id());
    }
}
