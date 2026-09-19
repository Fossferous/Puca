/**
 * Say why the server refused. Every task write in the calendars and Notes
 * funnels its error through here: an ApiError carries the server's own
 * human sentence (a 403 "Missing Complete Tasks permission", a 409 "update
 * the app"), and showing it is the difference between "nothing happened"
 * and knowing what to do. Anything else (offline, a bug) is only logged by
 * the caller — the next refetch shows the truth.
 */
import { ApiError } from './client';
import { pushMessageToast } from '../components/messageToastBus';

export function toastRefusal(err: unknown): boolean {
    if (!(err instanceof ApiError)) return false;
    pushMessageToast({ title: err.message });
    return true;
}
