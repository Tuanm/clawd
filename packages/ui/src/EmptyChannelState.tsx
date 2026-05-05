interface Props {
  onGetStarted: () => void;
}

/**
 * First-run empty state for a channel with no messages.
 * Single CTA — opens the Agents dialog.
 */
export default function EmptyChannelState({ onGetStarted }: Props) {
  return (
    <div className="empty-channel-state">
      <button type="button" className="empty-channel-state-btn empty-channel-state-btn--primary" onClick={onGetStarted}>
        Get started
      </button>
    </div>
  );
}
