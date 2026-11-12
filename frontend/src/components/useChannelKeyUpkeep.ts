/**
 * Keep every member of a server holding the keys they need, as one of the
 * members who already hold them.
 *
 * Channel keys are wrapped per member, so whoever joins a server holds
 * nothing for any channel's current epoch until a member who does re-wraps
 * it for them (api/channelKeys.ts, rewrapForMembershipChange). Two moments do
 * that here, and both cover text AND voice channels (keyedChannelIds):
 *
 *  - ON `MemberJoined`. Every member who holds the keys runs it; the helper
 *    staggers them and collapses to a single rotation. Until 0.9.861 this
 *    passed only text channels, so a newcomer got no voice key and every SFU
 *    voice room whose key predated them refused the join ("Channel encryption
 *    key unavailable — cannot join encrypted call") until somebody holding
 *    that room's key happened to join it.
 *
 *  - ONCE PER SERVER PER SIGN-IN, when this device first loads that server's
 *    channels (the CATCH-UP). `MemberJoined` reaches only members online at
 *    that moment, so somebody who joined while every holder was offline, or
 *    while the holders ran a version without the line above, kept waiting
 *    until a holder wrote in that very channel or joined that very room.
 *    Measured on a live server the day this was written: eleven member/text
 *    channel pairs and one member/voice room pair in that state. The
 *    catch-up asks each channel's key state once, and rotates only where the
 *    member generation has moved since its key was minted (the same rule a
 *    send applies, so a leaver's key is retired here too); it mints nothing
 *    for a channel that has no key yet (`bootstrap: false`).
 *
 * Kept apart from Chat's MemberJoined notification effect ON PURPOSE: that
 * one is muted for quiet servers and skips blocked users, and neither should
 * decide whether somebody can speak.
 */
import { useEffect, useRef } from 'react';
import { wsClient, type ServerMessage } from '../api/websocket';
import { keyedChannelIds, rewrapForMembershipChange } from '../api/channelKeys';
import { listChannels, type Channel, type Server } from '../api/servers';

export interface ChannelKeyUpkeepInput {
    currentUserId: number;
    servers: ReadonlyArray<Pick<Server, 'id'>>;
    currentServerId: string | null | undefined;
    /** The channels loaded for `currentServerId` (Chat's useChannels). */
    channels: ReadonlyArray<Pick<Channel, 'id' | 'channel_type' | 'server_id'>>;
    /** Whether `channels` has been fetched for `currentServerId` yet. */
    channelsFetched: boolean;
}

export function useChannelKeyUpkeep({ currentUserId, servers, currentServerId, channels, channelsFetched }: ChannelKeyUpkeepInput): void {
    // Someone joined one of our servers: give them a key for every channel.
    useEffect(() => {
        const rewrapForJoiner = async (msg: ServerMessage) => {
            const p = msg.payload as { server_id: string; user: { id: number } };
            if (p.user.id === currentUserId) return;               // we are the joiner
            if (!servers.some(s => s.id === p.server_id)) return;  // not our server
            try {
                // The loaded list covers the server being VIEWED; any other
                // needs a fetch, which is one request on a rare event.
                const list = currentServerId === p.server_id
                    ? channels
                    : await listChannels(p.server_id);
                await rewrapForMembershipChange(keyedChannelIds(list));
            } catch (e) {
                console.debug('[e2ee] could not re-wrap keys for the new member:', e);
            }
        };
        wsClient.on('MemberJoined', rewrapForJoiner);
        return () => wsClient.off('MemberJoined', rewrapForJoiner);
    }, [currentUserId, servers, currentServerId, channels]);

    // The catch-up: once per server per sign-in, when its channels arrive.
    const caughtUp = useRef<{ user: number; servers: Set<string> }>({ user: 0, servers: new Set() });
    useEffect(() => {
        if (!currentUserId || !currentServerId || !channelsFetched) return;
        // A different account on this device starts its own catch-up.
        if (caughtUp.current.user !== currentUserId) caughtUp.current = { user: currentUserId, servers: new Set() };
        if (caughtUp.current.servers.has(currentServerId)) return;
        // Only the list that belongs to this server: react-query can hand over
        // the previous server's list for a render while the new one loads.
        const own = channels.filter(c => c.server_id === currentServerId);
        if (own.length === 0) return;
        caughtUp.current.servers.add(currentServerId);
        void rewrapForMembershipChange(keyedChannelIds(own), { bootstrap: false }).catch((e) => {
            console.debug('[e2ee] key catch-up skipped:', e);
        });
    }, [currentUserId, currentServerId, channels, channelsFetched]);
}
