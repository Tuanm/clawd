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
        {isListening ? (
          /* Filled mic — active/recording */
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 10a2 2 0 0 0 2-2V4a2 2 0 1 0-4 0v4a2 2 0 0 0 2 2z" />
            <path d="M12 8a1 1 0 0 0-2 0 2 2 0 0 1-4 0 1 1 0 0 0-2 0 4 4 0 0 0 3 3.87V13H6v1h4v-1H9v-1.13A4 4 0 0 0 12 8z" />
          </svg>
        ) : (
          /* Simple outline mic — idle */
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="6" y="2" width="4" height="7" rx="2" />
            <path d="M12 8a4 4 0 0 1-8 0" />
            <path d="M8 12v2M6.5 14h3" />
          </svg>
        )}
      </button>
      {error && (
        <span className="mic-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
