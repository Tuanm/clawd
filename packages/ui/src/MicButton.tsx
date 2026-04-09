interface MicButtonProps {
  isListening: boolean;
  isSupported: boolean;
  onClick: () => void;
  error: string | null;
}

export default function MicButton({ isListening, isSupported, onClick, error }: MicButtonProps) {
  if (!isSupported) return null;

  const label = isListening ? "Stop voice input" : "Start voice input";

  return (
    <div className="mic-btn-wrapper">
      <button
        className={`action-btn mic-btn${isListening ? " mic-active" : ""}`}
        onClick={onClick}
        aria-label={label}
        aria-pressed={isListening}
        title={error || label}
        type="button"
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="5.5" y="1.5" width="5" height="7" rx="2.5" fill="currentColor" />
          <path d="M4 8.5a4 4 0 0 0 8 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {error && (
        <span className="mic-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
