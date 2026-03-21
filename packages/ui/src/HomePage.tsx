// Home page — branding + input with channel dropdown
import { useCallback, useEffect, useRef, useState } from "react";

const CHANNELS_STORAGE_KEY = "clawd-open-channels";

function getStoredChannels(): string[] {
  try {
    const stored = localStorage.getItem(CHANNELS_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function removeStoredChannel(channel: string): string[] {
  const channels = getStoredChannels().filter((c) => c !== channel);
  localStorage.setItem(CHANNELS_STORAGE_KEY, JSON.stringify(channels));
  return channels;
}

function SendIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
  );
}

function CopilotLogo() {
  return (
    <svg
      width="66"
      height="52"
      viewBox="0 0 512 416"
      fill="hsl(15 63.1% 59.6%)"
      fillRule="evenodd"
      clipRule="evenodd"
      strokeLinejoin="round"
      strokeMiterlimit={2}
      className="copilot-logo"
    >
      <path
        d="M181.33 266.143c0-11.497 9.32-20.818 20.818-20.818 11.498 0 20.819 9.321 20.819 20.818v38.373c0 11.497-9.321 20.818-20.819 20.818-11.497 0-20.818-9.32-20.818-20.818v-38.373zM308.807 245.325c-11.477 0-20.798 9.321-20.798 20.818v38.373c0 11.497 9.32 20.818 20.798 20.818 11.497 0 20.818-9.32 20.818-20.818v-38.373c0-11.497-9.32-20.818-20.818-20.818z"
        fillRule="nonzero"
      />
      <path d="M512.002 246.393v57.384c-.02 7.411-3.696 14.638-9.67 19.011C431.767 374.444 344.695 416 256 416c-98.138 0-196.379-56.542-246.33-93.21-5.975-4.374-9.65-11.6-9.671-19.012v-57.384a35.347 35.347 0 016.857-20.922l15.583-21.085c8.336-11.312 20.757-14.31 33.98-14.31 4.988-56.953 16.794-97.604 45.024-127.354C155.194 5.77 226.56 0 256 0c29.441 0 100.807 5.77 154.557 62.722 28.19 29.75 40.036 70.401 45.025 127.354 13.263 0 25.602 2.936 33.958 14.31l15.583 21.127c4.476 6.077 6.878 13.345 6.878 20.88zm-97.666-26.075c-.677-13.058-11.292-18.19-22.338-21.824-11.64 7.309-25.848 10.183-39.46 10.183-14.454 0-41.432-3.47-63.872-25.869-5.667-5.625-9.527-14.454-12.155-24.247a212.902 212.902 0 00-20.469-1.088c-6.098 0-13.099.349-20.551 1.088-2.628 9.793-6.509 18.622-12.155 24.247-22.4 22.4-49.418 25.87-63.872 25.87-13.612 0-27.86-2.855-39.501-10.184-11.005 3.613-21.558 8.828-22.277 21.824-1.17 24.555-1.272 49.11-1.375 73.645-.041 12.318-.082 24.658-.288 36.976.062 7.166 4.374 13.818 10.882 16.774 52.97 24.124 103.045 36.278 149.137 36.278 46.01 0 96.085-12.154 149.014-36.278 6.508-2.956 10.84-9.608 10.881-16.774.637-36.832.124-73.809-1.642-110.62h.041zM107.521 168.97c8.643 8.623 24.966 14.392 42.56 14.392 13.448 0 39.03-2.874 60.156-24.329 9.28-8.951 15.05-31.35 14.413-54.079-.657-18.231-5.769-33.28-13.448-39.665-8.315-7.371-27.203-10.574-48.33-8.644-22.399 2.238-41.267 9.588-50.875 19.833-20.798 22.728-16.323 80.317-4.476 92.492zm130.556-56.008c.637 3.51.965 7.35 1.273 11.517 0 2.875 0 5.77-.308 8.952 6.406-.636 11.847-.636 16.959-.636s10.553 0 16.959.636c-.329-3.182-.329-6.077-.329-8.952.329-4.167.657-8.007 1.294-11.517-6.735-.637-12.812-.965-17.924-.965s-11.21.328-17.924.965zm49.275-8.008c-.637 22.728 5.133 45.128 14.413 54.08 21.105 21.454 46.708 24.328 60.155 24.328 17.596 0 33.918-5.769 42.561-14.392 11.847-12.175 16.322-69.764-4.476-92.492-9.608-10.245-28.476-17.595-50.875-19.833-21.127-1.93-40.015 1.273-48.33 8.644-7.679 6.385-12.791 21.434-13.448 39.665z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="plus-icon">
      <path d="M12 5v14M5 12h14" stroke="hsl(15 63.1% 59.6%)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ClawdSvg() {
  return (
    <svg width="66" height="52" viewBox="0 0 66 52" fill="none" className="clawd-svg">
      <rect x="0" y="13" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
      <rect x="60" y="13" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
      <rect x="6" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
      <rect x="18" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
      <rect x="42" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
      <rect x="54" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
      <rect x="6" width="54" height="39" fill="hsl(15 63.1% 59.6%)" />
      <rect x="12" y="13" width="6" height="6.5" fill="#000" className="eye" />
      <rect x="48" y="13" width="6" height="6.5" fill="#000" className="eye" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export default function HomePage() {
  const [spaceId, setSpaceId] = useState("");
  const [channels, setChannels] = useState(() => getStoredChannels());
  const [showDropdown, setShowDropdown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Focus input on mount
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const navigateToSpace = useCallback(() => {
    const id = spaceId.trim();
    if (id) {
      if (!/^[\w.-]+$/.test(id)) return;
      window.location.pathname = `/${id}`;
    }
  }, [spaceId]);

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && spaceId.trim()) {
      navigateToSpace();
    }
    if (e.key === "Escape") {
      setShowDropdown(false);
    }
  };

  const handleRemoveChannel = useCallback((ch: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = removeStoredChannel(ch);
    setChannels(updated);
  }, []);

  // Filter channels by input text
  const query = spaceId.trim().toLowerCase();
  const filteredChannels = query ? channels.filter((ch) => ch.toLowerCase().includes(query)) : channels;

  const shouldShowDropdown = showDropdown && filteredChannels.length > 0;

  return (
    <div className="home-page">
      <div className="branding-container">
        <div className="branding-row">
          <div className="copilot-wrapper">
            <CopilotLogo />
          </div>
          <div className="plus-wrapper">
            <PlusIcon />
          </div>
          <div className="clawd-brand-wrapper">
            <ClawdSvg />
          </div>
        </div>
        <div className="home-input-wrapper" ref={wrapperRef}>
          <div className="home-space-input branding-input">
            <input
              ref={inputRef}
              type="text"
              className="home-space-field"
              placeholder="Explore..."
              value={spaceId}
              onChange={(e) => {
                setSpaceId(e.target.value);
                setShowDropdown(true);
              }}
              onFocus={() => setShowDropdown(true)}
              onKeyDown={handleInputKeyDown}
            />
            <button
              className={`home-space-send ${spaceId.trim() ? "has-content" : ""}`}
              onClick={navigateToSpace}
              disabled={!spaceId.trim()}
            >
              <SendIcon />
            </button>
          </div>
          {shouldShowDropdown && (
            <div className="home-dropdown">
              {filteredChannels.map((ch) => (
                <div
                  key={ch}
                  className="home-dropdown-item"
                  onClick={() => {
                    window.location.pathname = `/${ch}`;
                  }}
                >
                  <span className="home-dropdown-item-name">{ch}</span>
                  <button
                    className="home-dropdown-item-remove"
                    onClick={(e) => handleRemoveChannel(ch, e)}
                    title="Remove from list"
                  >
                    <CloseIcon />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
