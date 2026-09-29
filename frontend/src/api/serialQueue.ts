/**
 * Run async work one item at a time, in call order.
 *
 * Extracted rather than inlined because the property it provides is worth a test
 * of its own, and a test that re-implements a queue would prove nothing about
 * the one actually used.
 *
 * The problem it solves, concretely: a sealed signalling frame carries a
 * strictly-increasing counter, assigned synchronously, and is then sealed
 * asynchronously through WebCrypto. Two concurrent senders take n=0 and n=1 and
 * race; if n=1 finishes sealing first it is sent first, and the receiver — which
 * requires strictly increasing n — discards the legitimate n=0 frame as a
 * replay. setLocalDescription starts ICE gathering, so onicecandidate fires
 * while the answer is still being sealed. The race is the normal case, not a
 * corner.
 *
 * The saved tab order has the same shape of race. A new note's place is
 * READ from the server and then written back as an insert (api/listContent.ts
 * placeNewListFirst, notes/model/notesOutbox.ts execOp), and a pin, a
 * favourite or a drag saved between the read and the write is undone by it —
 * so Púca's Tasks view and Púca Notes each send their tab-order writes through
 * one of these. Shared, not remote-control code: the lite build keeps it
 * (vite.shared.ts).
 */
export class SerialQueue {
    private tail: Promise<void> = Promise.resolve();

    /**
     * Queue `fn`. It starts only once everything queued before it has settled,
     * and the returned promise resolves with its result.
     *
     * A rejecting `fn` does NOT wedge the queue: the chain advances on settle,
     * not on success. Getting that wrong would mean one failed send silently
     * killing every later signal on that session.
     */
    run<T>(fn: () => Promise<T>): Promise<T> {
        const result = this.tail.then(fn, fn);
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }
}
