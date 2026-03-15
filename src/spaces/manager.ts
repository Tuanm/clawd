import { type Message, updateSubspaceStatus } from "../server/database";
import { broadcastUpdate } from "../server/websocket";
import {
  atomicLockSpace,
  type CreateSpaceParams,
  createSpaceRecord,
  deleteSpaceAgents,
  getActiveSpaces,
  getSpace,
  getSpaceByChannel,
  listSpaces,
  resetSpaceForRetask,
  type Space,
  updateCardTs,
} from "./db";

export class SpaceManager {
  createSpace(params: CreateSpaceParams): Space {
    return createSpaceRecord(params);
  }

  lockSpace(spaceId: string, status: string, resultOrError?: string): boolean {
    return atomicLockSpace(spaceId, status, resultOrError);
  }

  updateSpaceCard(spaceId: string): void {
    const space = getSpace(spaceId);
    if (!space || !space.card_message_ts) return;

    const newSubspaceJson = JSON.stringify({
      id: space.id,
      title: space.title,
      description: space.description,
      agent_id: space.agent_id,
      agent_color: space.agent_color,
      status: space.status,
      channel: space.channel,
    });

    const updatedMsg = updateSubspaceStatus(space.card_message_ts, space.channel, newSubspaceJson);
    if (updatedMsg) {
      broadcastUpdate(space.channel, updatedMsg);
    }
  }

  completeSpace(spaceId: string, summary: string): boolean {
    const won = this.lockSpace(spaceId, "completed", summary);
    if (won) this.updateSpaceCard(spaceId);
    return won;
  }

  failSpace(spaceId: string, error: string): boolean {
    const won = this.lockSpace(spaceId, "failed", error);
    if (won) this.updateSpaceCard(spaceId);
    return won;
  }

  timeoutSpace(spaceId: string): boolean {
    const won = this.lockSpace(spaceId, "timed_out", "Timed out");
    if (won) this.updateSpaceCard(spaceId);
    return won;
  }

  getSpace(spaceId: string): Space | null {
    return getSpace(spaceId);
  }

  listSpaces(channel: string, status?: string): Space[] {
    return listSpaces(channel, status);
  }

  getActiveSpaces(): Space[] {
    return getActiveSpaces();
  }

  updateCardTs(spaceId: string, ts: string): void {
    updateCardTs(spaceId, ts);
  }

  cleanupSpaceAgents(spaceId: string): void {
    const space = getSpace(spaceId);
    if (space) deleteSpaceAgents(space.space_channel);
  }

  resetSpace(spaceId: string): boolean {
    return resetSpaceForRetask(spaceId);
  }
}
