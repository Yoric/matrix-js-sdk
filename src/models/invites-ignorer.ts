/*
Copyright 2022 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { MatrixClient } from "../client";
import { EventTimeline, MatrixEvent, Preset } from "../matrix";
import { globToRegexp } from "../utils";
import { Room } from "./room";

/// The event type storing the user's individual policies.
///
/// Exported for testing purposes.
export const POLICIES_ACCOUNT_EVENT_TYPE = "org.matrix.msc3847.policies";

/// The key within the user's individual policies storing the user's ignored invites.
///
/// Exported for testing purposes.
export const IGNORE_INVITES_ACCOUNT_EVENT_KEY = "org.matrix.msc3847.ignore.invites";

/// The types of recommendations understood.
enum PolicyRecommendation {
    Ban = "m.ban",
}

/**
 * The various scopes for policies.
 */
export enum PolicyScope {
    /**
     * The policy deals with an individual user, e.g. reject invites
     * from this user.
     */
    User = "m.policy.user",

    /**
     * The policy deals with a room, e.g. reject invites towards
     * a specific room.
     */
    Room = "m.policy.room",

    /**
     * The policy deals with a server, e.g. reject invites from
     * this server.
     */
    Server = "m.policy.server",
}

/**
 * A container for ignored invites.
 *
 * # Performance
 *
 * This implementation is extremely naive. It expects that we are dealing
 * with a very short list of sources (e.g. only one). If real-world
 * applications turn out to require longer lists, we may need to rework
 * our data structures.
 */
export class IgnoredInvites {
    constructor(
        private readonly client: MatrixClient,
    ) {
    }

    /**
     * Add a new rule.
     *
     * @param scope The scope for this rule.
     * @param entity The entity covered by this rule. Globs are supported.
     * @param reason A human-readable reason for introducing this new rule.
     * @return The event id for the new rule.
     */
    public async addRule(scope: PolicyScope, entity: string, reason: string): Promise<string> {
        const target = await this.getOrCreateTargetRoom();
        const response = await this.client.sendStateEvent(target.roomId, scope, {
            entity,
            reason,
            recommendation: PolicyRecommendation.Ban,
        });
        return response.event_id;
    }

    /**
     * Remove a rule.
     */
    public async removeRule(event: MatrixEvent) {
        await this.client.redactEvent(event.getRoomId()!, event.getId()!);
    }

    /**
     * Add a new room to the list of sources. If the user isn't a member of the
     * room, attempt to join it.
     *
     * @param roomId A valid room id. If this room is already in the list
     * of sources, it will not be duplicated.
     * @return `true` if the source was added, `false` if it was already present.
     * @throws If `roomId` isn't the id of a room that the current user is already
     * member of or can join.
     *
     * # Safety
     *
     * This method will rewrite the `Policies` object in the user's account data.
     * This rewrite is inherently racy and could overwrite or be overwritten by
     * other concurrent rewrites of the same object.
     */
    public async addSource(roomId: string): Promise<boolean> {
        // We attempt to join the room *before* calling
        // `await this.getOrCreateSourceRooms()` to decrease the duration
        // of the racy section.
        await this.client.joinRoom(roomId);
        // Race starts.
        const sources = (await this.getOrCreateSourceRooms())
            .map(room => room.roomId);
        if (sources.includes(roomId)) {
            return false;
        }
        sources.push(roomId);
        const policies = this.client.getAccountData(POLICIES_ACCOUNT_EVENT_TYPE)?.getContent() || {};

        const ignoreInvitesPolicies = policies[IGNORE_INVITES_ACCOUNT_EVENT_KEY] || {};
        ignoreInvitesPolicies.sources = sources;
        await this.client.setAccountData(POLICIES_ACCOUNT_EVENT_TYPE, policies);

        // Race ends.
        return true;
    }

    /**
     * Find out whether an invite should be ignored.
     *
     * @param sender The user id for the user who issued the invite.
     * @param roomId The room to which the user is invited.
     * @returns A rule matching the entity, if any was found, `null` otherwise.
     */
    public async getRuleForInvite({ sender, roomId }: {
        sender: string;
        roomId: string;
    }): Promise<Readonly<MatrixEvent | null>> {
        // In this implementation, we perform a very naive lookup:
        // - search in each policy room;
        // - turn each (potentially glob) rule entity into a regexp.
        //
        // Real-world testing will tell us whether this is performant enough.
        // In the (unfortunately likely) case it isn't, there are several manners
        // in which we could optimize this:
        // - match several entities per go;
        // - pre-compile each rule entity into a regexp;
        // - pre-compile entire rooms into a single regexp.
        const policyRooms = await this.getOrCreateSourceRooms();
        const senderServer = sender.split(":")[1];
        const roomServer = roomId.split(":")[1];
        for (const room of policyRooms) {
            const state = room.getUnfilteredTimelineSet().getLiveTimeline().getState(EventTimeline.FORWARDS);

            for (const { scope, entities } of [
                { scope: PolicyScope.Room, entities: [roomId] },
                { scope: PolicyScope.User, entities: [sender] },
                { scope: PolicyScope.Server, entities: [senderServer, roomServer] },
            ]) {
                const events = state.getStateEvents(scope);
                for (const event of events) {
                    const content = event.getContent();
                    if (content?.recommendation != PolicyRecommendation.Ban) {
                        // Ignoring invites only looks at `m.ban` recommendations.
                        continue;
                    }
                    const glob = content?.entity;
                    if (!glob) {
                        // Invalid event.
                        continue;
                    }
                    let regexp: string;
                    try {
                        regexp = globToRegexp(glob, false);
                    } catch (ex) {
                        // Assume invalid event.
                        continue;
                    }
                    for (const entity of entities) {
                        if (entity && entity.search(regexp) >= 0) {
                            return event;
                        }
                    }
                    // No match.
                }
            }
        }
        return null;
    }

    /**
     * Get the target room, i.e. the room in which any new rule should be written.
     *
     * If there is no target room setup, a target room is created.
     *
     * Note: This method is public for testing reasons. Most clients should not need
     * to call it directly.
     *
     * # Safety
     *
     * This method will rewrite the `Policies` object in the user's account data.
     * This rewrite is inherently racy and could overwrite or be overwritten by
     * other concurrent rewrites of the same object.
     */
    public async getOrCreateTargetRoom(): Promise<Room> {
        const policies = this.client.getAccountData(POLICIES_ACCOUNT_EVENT_TYPE)?.getContent() || {};
        const ignoreInvitesPolicies = policies[IGNORE_INVITES_ACCOUNT_EVENT_KEY] || {};
        let target = ignoreInvitesPolicies.target;
        // Validate `target`. If it is invalid, trash out the current `target`
        // and create a new room.
        if (typeof target !== "string") {
            target = null;
        }
        if (target) {
            // Check that the room exists and is valid.
            const room = this.client.getRoom(target);
            if (room) {
                return room;
            } else {
                target = null;
            }
        }
        // We need to create our own policy room for ignoring invites.
        target = (await this.client.createRoom({
            name: "Individual Policy Room",
            preset: Preset.PrivateChat,
        })).room_id;
        ignoreInvitesPolicies.target = target;
        policies[IGNORE_INVITES_ACCOUNT_EVENT_KEY] = ignoreInvitesPolicies;
        await this.client.setAccountData(POLICIES_ACCOUNT_EVENT_TYPE, policies);

        // Since we have just called `createRoom`, `getRoom` should not be `null`.
        return this.client.getRoom(target)!;
    }

    /**
     * Get the list of source rooms, i.e. the rooms from which rules need to be read.
     *
     * If no source rooms are setup, the target room is used as sole source room.
     *
     * Note: This method is public for testing reasons. Most clients should not need
     * to call it directly.
     *
     * # Safety
     *
     * This method will rewrite the `Policies` object in the user's account data.
     * This rewrite is inherently racy and could overwrite or be overwritten by
     * other concurrent rewrites of the same object.
     */
    public async getOrCreateSourceRooms(): Promise<Room[]> {
        const policies = this.client.getAccountData(POLICIES_ACCOUNT_EVENT_TYPE)?.getContent() || {};
        const ignoreInvitesPolicies = policies[IGNORE_INVITES_ACCOUNT_EVENT_KEY] || {};
        let sources = ignoreInvitesPolicies.sources;

        // Validate `sources`. If it is invalid, trash out the current `sources`
        // and create a new list of sources from `target`.
        let hasChanges = false;
        if (!Array.isArray(sources)) {
            // `sources` could not be an array.
            hasChanges = true;
            sources = [];
        }
        let sourceRooms: Room[] = sources
            // `sources` could contain non-string / invalid room ids
            .filter(roomId => typeof roomId === "string")
            .map(roomId => this.client.getRoom(roomId))
            .filter(room => !!room);
        if (sourceRooms.length != sources.length) {
            hasChanges = true;
        }
        if (sourceRooms.length == 0) {
            // `sources` could be empty (possibly because we've removed
            // invalid content)
            const target = await this.getOrCreateTargetRoom();
            hasChanges = true;
            sourceRooms = [target];
        }
        if (hasChanges) {
            // Reload `policies`/`ignoreInvitesPolicies` in case it has been changed
            // during or by our call to `this.getTargetRoom()`.
            const policies = this.client.getAccountData(POLICIES_ACCOUNT_EVENT_TYPE)?.getContent() || {};
            const ignoreInvitesPolicies = policies[IGNORE_INVITES_ACCOUNT_EVENT_KEY] || {};
            sources = sourceRooms.map(room => room.roomId);
            policies[IGNORE_INVITES_ACCOUNT_EVENT_KEY] = ignoreInvitesPolicies;
            ignoreInvitesPolicies.sources = sources;
            await this.client.setAccountData(POLICIES_ACCOUNT_EVENT_TYPE, policies);
        }
        return sourceRooms;
    }
}
