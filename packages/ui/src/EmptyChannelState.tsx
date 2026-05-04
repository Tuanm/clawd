import { ClawdAvatar } from "./MessageList";

interface Props {
  channel: string;
  hasAgents: boolean;
  onAddAgent: () => void;
  onFocusComposer: () => void;
}

/**
 * First-run empty state for a channel with no messages. Replaces the
 * blank-screen behaviour described in P0-1 of the UX audit. Surfaces the
 * two next steps: add an agent, or send a message yourself.
 */
export default function EmptyChannelState({ channel, hasAgents, onAddAgent, onFocusComposer }: Props) {
  return (
    <div className="empty-channel-state">
      <ClawdAvatar color="#D97853" />
      <h2 className="empty-channel-state-title">Welcome to #{channel}</h2>
      <p className="empty-channel-state-message">
        {hasAgents
          ? "Send a message to get the conversation started — your agents are ready and listening."
          : "This channel is empty. Add an autonomous agent to collaborate with, or start the conversation yourself."}
      </p>
      <div className="empty-channel-state-actions">
        {!hasAgents && (
          <button
            type="button"
            className="empty-channel-state-btn empty-channel-state-btn--primary"
            onClick={onAddAgent}
          >
            Add an agent
          </button>
        )}
        <button type="button" className="empty-channel-state-btn" onClick={onFocusComposer}>
          Start typing
        </button>
      </div>
    </div>
  );
}
