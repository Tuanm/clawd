import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AgentDialog from "./AgentDialog";
import AgentFilesChannel from "./AgentFilesChannel";
import { authFetch, getStoredAuthToken, setStoredAuthToken } from "./auth-fetch";
import McpDialog, { McpIcon } from "./McpDialog";
import MessageComposer from "./MessageComposer";
import MessageList, { StreamOutputDialog } from "./MessageList";
import TodoDialog from "./PlanModal";
import ProjectsDialog from "./ProjectsDialog";
import SearchModal from "./SearchModal";
import SidebarPanel from "./SidebarPanel";
import SkillFilesChannel from "./SkillFilesChannel";
import SkillsDialog from "./SkillsDialog";
import { UnreadBadge } from "./UnreadBadge";
import WorktreeDialog from "./WorktreeDialog";

interface SeenByAgent {
  agent_id: string;
  avatar_color: string;
  is_sleeping?: boolean;
}

interface Message {
  ts: string;
  user: string;
  text: string;
  thread_ts?: string;
  files?: { id: string; name: string; url_private: string }[];
  reactions?: { name: string; count: number }[];
  // Multi-agent support
  agent_id?: string;
  avatar_color?: string;
  is_sleeping?: boolean;
  is_streaming?: boolean;
  thinking_text?: string; // Streamed thinking tokens (separate from content)
  seen_by?: SeenByAgent[];
  // Interactive artifact state
  interactive?: string;
  interactive_acted?: boolean;
}

// Pending message for optimistic UI
export interface PendingMessage {
  id: string;
  text: string;
  files?: File[];
  status: "sending" | "sent" | "failed";
  error?: string;
  sentTs?: string; // Track approximate timestamp for matching
}

// Helper to check if message is from an agent
const isAgentMessage = (msg: Message) => msg.user === "UBOT" || msg.user?.startsWith("UWORKER-") || !!msg.agent_id;

interface AgentStatus {
  status: string;
  hibernate_until: string | null;
  auto_hibernate?: boolean;
}

interface Props {
  channel: string;
  /** When set, App renders in article mode — shows only this article as a single message */
  articleId?: string;
}

const API_URL = "";

// Auth helpers imported from ./auth-fetch

// Header Clawd SVG (smaller version)
function ClawdLogo({ sleeping = false, hasUnread = false }: { sleeping?: boolean; hasUnread?: boolean }) {
  const color = sleeping ? "hsl(0 0% 60%)" : "hsl(15 63.1% 59.6%)";
  const eyeHeight = sleeping ? "2" : "6.5";
  const eyeY = sleeping ? "16" : "13";
  return (
    <div className="clawd-logo-wrapper">
      <svg width="28" height="22" viewBox="0 0 66 52" fill="none">
        <rect x="0" y="13" width="6" height="13" fill={color} />
        <rect x="60" y="13" width="6" height="13" fill={color} />
        <rect x="6" y="39" width="6" height="13" fill={color} />
        <rect x="18" y="39" width="6" height="13" fill={color} />
        <rect x="42" y="39" width="6" height="13" fill={color} />
        <rect x="54" y="39" width="6" height="13" fill={color} />
        <rect x="6" width="54" height="39" fill={color} />
        <rect x="12" y={eyeY} width="6" height={eyeHeight} fill="#000" />
        <rect x="48" y={eyeY} width="6" height={eyeHeight} fill="#000" />
      </svg>
      {hasUnread && <span className="clawd-unread-dot" />}
    </div>
  );
}

// Connection indicator copilot logo
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

// Small agent avatar for header
function AgentAvatarSmall({ color }: { color: string }) {
  return (
    <svg width="16" height="13" viewBox="0 0 66 52" fill="none">
      <rect x="0" y="13" width="6" height="13" fill={color} />
      <rect x="60" y="13" width="6" height="13" fill={color} />
      <rect x="6" y="39" width="6" height="13" fill={color} />
      <rect x="18" y="39" width="6" height="13" fill={color} />
      <rect x="42" y="39" width="6" height="13" fill={color} />
      <rect x="54" y="39" width="6" height="13" fill={color} />
      <rect x="6" width="54" height="39" fill={color} />
      <rect x="12" y="13" width="6" height="6.5" fill="#000" />
      <rect x="48" y="13" width="6" height="6.5" fill="#000" />
    </svg>
  );
}

// Manage open channels in localStorage
const CHANNELS_STORAGE_KEY = "clawd-open-channels";

function getStoredChannels(): string[] {
  try {
    const stored = localStorage.getItem(CHANNELS_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function addStoredChannel(channel: string): string[] {
  const channels = getStoredChannels();
  if (!channels.includes(channel)) {
    channels.push(channel);
    localStorage.setItem(CHANNELS_STORAGE_KEY, JSON.stringify(channels));
  }
  return channels;
}

function removeStoredChannel(channel: string): string[] {
  const channels = getStoredChannels().filter((c) => c !== channel);
  localStorage.setItem(CHANNELS_STORAGE_KEY, JSON.stringify(channels));
  return channels;
}

// Notification sound using Web Audio API
function playNotificationSound() {
  try {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    // Pleasant notification tone (two-tone chime)
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime); // A5
    oscillator.frequency.setValueAtTime(1108.73, audioContext.currentTime + 0.1); // C#6

    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.3);
  } catch (_e) {
    // Ignore audio errors (e.g., autoplay restrictions)
  }
}

// Desktop notification via Service Worker
// Shows OS-level notification when tab is hidden/unfocused
function showDesktopNotification(agentName: string, text: string, channel: string) {
  // Only show when page is not visible (tab backgrounded or minimized)
  if (document.visibilityState === "visible") return;

  // Check if notification permission is granted
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  // Truncate long messages
  const maxLen = 120;
  const body = text.length > maxLen ? text.substring(0, maxLen) + "..." : text;

  // Use Service Worker to show notification (works even when tab is inactive)
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: "SHOW_NOTIFICATION",
      title: `${agentName} -- Claw'd`,
      body,
      channel,
    });
  } else {
    // Fallback: direct Notification API (requires tab to be active)
    try {
      new Notification(`${agentName} -- Claw'd`, {
        body,
        icon: "/clawd-192.png",
        tag: `clawd-${channel}`,
      });
    } catch (_e) {
      // Ignore notification errors
    }
  }
}

// Request notification permission (called once on user interaction)
async function requestNotificationPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;

  const result = await Notification.requestPermission();
  return result === "granted";
}

// Streaming output types (for real-time agent output dialog)
export interface StreamEntry {
  type: "thinking" | "content" | "tool_start" | "tool_end" | "tool_error" | "event" | "session_divider";
  text: string;
  timestamp: number;
  toolName?: string;
  toolArgs?: any;
}

export interface StreamingAgentInfo {
  agentId: string;
  avatarColor: string;
  entries: StreamEntry[];
  completed?: boolean; // true when agent finished streaming (entries preserved for dialog)
}

// Per-channel state interface
interface ChannelState {
  messages: Message[];
  pendingMessages: PendingMessage[];
  agentLastSeenTs: string | null;
  userLastSeenTs: string | null; // Human user's last seen timestamp
  agentStatus: AgentStatus;
  hasMoreOlder: boolean; // renamed from hasMore
  hasMoreNewer: boolean; // NEW - for scrolling down
  loadingOlder: boolean; // renamed from loadingMore
  loadingNewer: boolean; // NEW
  isAtLatest: boolean; // true = normal mode, false = viewing history
  loaded: boolean;
  // Streaming agents - lightweight state for rendering indicator only
  streamingAgents: { agentId: string; avatarColor: string }[];
}

const defaultChannelState: ChannelState = {
  messages: [],
  pendingMessages: [],
  agentLastSeenTs: null,
  userLastSeenTs: null,
  agentStatus: {
    status: "ready",
    hibernate_until: null,
    auto_hibernate: false,
  },
  hasMoreOlder: false,
  hasMoreNewer: false,
  loadingOlder: false,
  loadingNewer: false,
  isAtLatest: true,
  loaded: false,
  streamingAgents: [],
};

// Swipeable channel row for the channel dialog (supports touch + mouse drag)
function ChannelDialogSwipeRow({
  channel,
  agents,
  unreadCount,
  onSwitch,
  onRemove,
}: {
  channel: string;
  agents: SeenByAgent[];
  unreadCount: number;
  onSwitch: () => void;
  onRemove: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const currentXRef = useRef(0);
  const swipingRef = useRef(false);
  const draggingRef = useRef(false);
  const removingRef = useRef(false);
  const [offset, setOffset] = useState(0);
  const [removing, setRemoving] = useState(false);
  const [animating, setAnimating] = useState(false);

  const SWIPE_THRESHOLD = 80; // px to trigger remove

  // --- Shared logic ---
  const onDragStart = useCallback((clientX: number) => {
    if (removingRef.current) return;
    startXRef.current = clientX;
    currentXRef.current = 0;
    swipingRef.current = false;
    draggingRef.current = false; // Only set true when actual movement detected
    setAnimating(false);
  }, []);

  const onDragMove = useCallback((clientX: number) => {
    if (removingRef.current) return;
    const diff = startXRef.current - clientX;
    if (diff > 10) {
      draggingRef.current = true;
      swipingRef.current = true;
      currentXRef.current = Math.min(diff, 120);
      setOffset(-currentXRef.current);
    } else if (diff < -10 && currentXRef.current > 0) {
      currentXRef.current = Math.max(0, currentXRef.current + diff);
      setOffset(-currentXRef.current);
    }
  }, []);

  const onDragEnd = useCallback(() => {
    if (removingRef.current) return;
    // If no actual drag movement, clear flags immediately (allow click through)
    if (!swipingRef.current) {
      draggingRef.current = false;
      return;
    }
    setAnimating(true);
    if (currentXRef.current > SWIPE_THRESHOLD) {
      removingRef.current = true;
      setRemoving(true);
      setOffset(-300);
      setTimeout(() => onRemove(), 200);
    } else {
      setOffset(0);
      // Clear drag flags after snap-back animation completes
      setTimeout(() => {
        draggingRef.current = false;
        swipingRef.current = false;
      }, 250);
    }
  }, [onRemove]);

  // --- Touch events ---
  const handleTouchStart = useCallback((e: React.TouchEvent) => onDragStart(e.touches[0].clientX), [onDragStart]);
  const handleTouchMove = useCallback((e: React.TouchEvent) => onDragMove(e.touches[0].clientX), [onDragMove]);
  const handleTouchEnd = useCallback(() => onDragEnd(), [onDragEnd]);

  // --- Mouse events ---
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (removingRef.current) return;
      onDragStart(e.clientX);
      const onMouseMove = (me: MouseEvent) => onDragMove(me.clientX);
      const onMouseUp = () => {
        onDragEnd();
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [onDragStart, onDragMove, onDragEnd],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Block click if we were dragging, swiping, or removing
      if (swipingRef.current || draggingRef.current || removingRef.current) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      onSwitch();
    },
    [onSwitch],
  );

  return (
    <div ref={rowRef} className={`channel-dialog-swipe-row ${removing ? "removing" : ""}`}>
      <div className="channel-dialog-swipe-bg">
        <span>Remove</span>
      </div>
      <div
        className="channel-dialog-swipe-content"
        style={{
          transform: `translateX(${offset}px)`,
          transition: animating ? "transform 0.2s ease" : "none",
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onMouseDown={handleMouseDown}
        onClick={handleClick}
      >
        <span className="channel-dialog-item-name">{channel}</span>
        <UnreadBadge count={unreadCount} />
        <div className="channel-dialog-item-meta">
          {agents.length > 0 && (
            <div className="channel-dialog-agents">
              {agents.map((agent) => (
                <AgentAvatarSmall key={agent.agent_id} color={agent.avatar_color} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LoginPrompt({ onLogin }: { onLogin: (token: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = value.trim();
    if (!t) {
      setError("Please enter a token.");
      return;
    }
    onLogin(t);
  };

  return (
    <div className="login-prompt-overlay">
      <form className="login-prompt" onSubmit={handleSubmit}>
        <ClawdLogo />
        <h2>Authentication Required</h2>
        <p>Enter your Claw'd access token to continue.</p>
        <input
          type="password"
          placeholder="Bearer token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        {error && <span className="login-error">{error}</span>}
        <button type="submit">Connect</button>
      </form>
    </div>
  );
}

export default function App({ channel: initialChannel, articleId }: Props) {
  const isArticleMode = !!articleId;
  // Active channel (can be switched without page reload)
  const [activeChannel, setActiveChannel] = useState(initialChannel);

  // Space mode detection
  const isSpaceChannel = activeChannel.includes(":");
  const parentChannel = isSpaceChannel ? activeChannel.split(":")[0] : null;
  const spaceId = isSpaceChannel ? activeChannel.split(":")[1] : null;

  // Management channel detection (no real agents, just management UI)
  const isManagementChannel = activeChannel === "agents" || activeChannel === "skills";

  // Per-channel state stored in a Map
  const [channelStates, setChannelStates] = useState<Map<string, ChannelState>>(() => {
    const map = new Map();
    map.set(initialChannel, { ...defaultChannelState });
    return map;
  });

  // Global state
  const [connected, setConnected] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [validProject, setValidProject] = useState<boolean | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(
    "Notification" in window ? Notification.permission : "denied",
  );
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const pollIntervalRef = useRef<number | null>(null);
  const isInitialLoadRef = useRef<Set<string>>(new Set());
  const subscribedChannelsRef = useRef<Set<string>>(new Set());
  // Refs for stable access in effects (avoid re-renders)
  const openChannelsRef = useRef<string[]>([]);
  const channelStatesRef = useRef<Map<string, ChannelState>>(new Map());
  const activeChannelRef = useRef(activeChannel);

  // Streaming output accumulator - stored outside React state for performance
  // Key: "channel:agentId", Value: StreamingAgentInfo
  const streamingOutputRef = useRef<Map<string, StreamingAgentInfo>>(new Map());
  // Version counter to notify dialog of updates without re-rendering the whole app
  const streamingVersionRef = useRef(0);

  // Channel switcher state
  const [openChannels, setOpenChannels] = useState<string[]>(() => {
    const stored = getStoredChannels();
    // Always include current channel
    if (!stored.includes(initialChannel) && !initialChannel.includes(":")) {
      return addStoredChannel(initialChannel);
    }
    return stored;
  });
  const [showChannelDialog, setShowChannelDialog] = useState(false);
  const [channelAgents, setChannelAgents] = useState<Record<string, SeenByAgent[]>>({});
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [showProjectsDialog, setShowProjectsDialog] = useState(false);
  const [projectsInitialAgent, setProjectsInitialAgent] = useState<string | null>(null);
  const [projectsInitialFile, setProjectsInitialFile] = useState<string | null>(null);
  const [projectsInitialLine, setProjectsInitialLine] = useState<number | null>(null);
  const [spaceInfo, setSpaceInfo] = useState<{
    title: string;
    status: "active" | "completed" | "failed" | "timed_out";
    channel: string;
    card_message_ts: string | null;
    agent_color: string;
    agent_id: string;
  } | null>(null);
  const [spaceError, setSpaceError] = useState(false);
  const isSpaceLocked = spaceInfo != null && spaceInfo.status !== "active";
  const [showAgentDialog, setShowAgentDialog] = useState(false);
  const [showMcpDialog, setShowMcpDialog] = useState(false);
  const [showWorktreeDialog, setShowWorktreeDialog] = useState(false);
  const [worktreeEnabled, setWorktreeEnabled] = useState(false);
  const [showSkillsDialog, setShowSkillsDialog] = useState(false);
  const [jumpToMessageTs, setJumpToMessageTs] = useState<string | null>(null);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [isActiveChannelAtBottom, setIsActiveChannelAtBottom] = useState(true);
  const [streamDialogOpen, setStreamDialogOpen] = useState(false);
  const [streamDialogAgentId, setStreamDialogAgentId] = useState<string | null>(null);

  // Sidebar panel state
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarContent, setSidebarContent] = useState<import("./SidebarPanel").SidebarPanelContent | null>(null);

  const openSidebar = useCallback((content: import("./SidebarPanel").SidebarPanelContent) => {
    setSidebarContent(content);
    setSidebarOpen(true);
  }, []);

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
    // Clear content after slide-out animation (300ms matches CSS transition)
    setTimeout(() => setSidebarContent(null), 300);
  }, []);

  // Helper to get current channel state
  const currentState = channelStates.get(activeChannel) || defaultChannelState;
  const {
    messages,
    pendingMessages,
    agentLastSeenTs,
    userLastSeenTs,
    agentStatus,
    hasMoreOlder,
    hasMoreNewer,
    loadingOlder,
    loadingNewer,
    isAtLatest,
    streamingAgents,
  } = currentState;

  // Helper to update a specific channel's state
  const updateChannelState = useCallback((channelId: string, updates: Partial<ChannelState>) => {
    setChannelStates((prev) => {
      const current = prev.get(channelId) || { ...defaultChannelState };

      // Check if any values actually changed
      let hasChanges = false;
      for (const key of Object.keys(updates) as (keyof ChannelState)[]) {
        const newVal = updates[key];
        const oldVal = current[key];
        // Simple comparison (works for primitives and same object references)
        if (newVal !== oldVal) {
          // Deep compare for objects
          if (typeof newVal === "object" && typeof oldVal === "object" && newVal !== null && oldVal !== null) {
            if (JSON.stringify(newVal) !== JSON.stringify(oldVal)) {
              hasChanges = true;
              break;
            }
          } else {
            hasChanges = true;
            break;
          }
        }
      }

      // Skip update if nothing changed (preserves text selection)
      if (!hasChanges) return prev;

      const newMap = new Map(prev);
      newMap.set(channelId, { ...current, ...updates });
      return newMap;
    });
  }, []);

  // Use channel directly (no C prefix needed anymore)
  const displayName = activeChannel;

  // Keep refs in sync with state (for use in effects without dependencies)
  useEffect(() => {
    openChannelsRef.current = openChannels;
  }, [openChannels]);

  useEffect(() => {
    channelStatesRef.current = channelStates;
  }, [channelStates]);

  useEffect(() => {
    activeChannelRef.current = activeChannel;
  }, [activeChannel]);

  // Update document title with unread count
  // Include active channel unread when user is scrolled up (not at bottom)
  useEffect(() => {
    const totalUnread = Object.entries(unreadCounts)
      .filter(([ch]) => ch !== activeChannel || !isActiveChannelAtBottom)
      .reduce((acc, [, count]) => acc + count, 0);
    const countDisplay = totalUnread > 99 ? "99+" : totalUnread.toString();
    const titleBase = spaceInfo?.agent_id
      ? `Claw'd | ${parentChannel} | ${spaceInfo.agent_id}`
      : `Claw'd | ${displayName}`;
    document.title = totalUnread > 0 ? `${titleBase} (${countDisplay})` : titleBase;
  }, [displayName, unreadCounts, activeChannel, isActiveChannelAtBottom, spaceInfo, parentChannel]);

  // Keyboard shortcut: Ctrl+F / Cmd+F for search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        setShowSearchModal(true);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Right-click prevention is handled globally in main.tsx Router

  // Prevent DevTools keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // F12
      if (e.key === "F12") {
        e.preventDefault();
        return;
      }
      // Ctrl+Shift+I / Cmd+Option+I (DevTools)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        return;
      }
      // Ctrl+Shift+J / Cmd+Option+J (Console)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        return;
      }
      // Ctrl+Shift+C / Cmd+Option+C (Inspector)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        return;
      }
      // Ctrl+U / Cmd+U (View Source)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "u") {
        e.preventDefault();
        return;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Focus new channel input when modal opens
  // Fetch agents for all channels when channel dialog opens
  useEffect(() => {
    if (!showChannelDialog) return;
    const fetchAllChannelAgents = async () => {
      const result: Record<string, SeenByAgent[]> = {};
      await Promise.all(
        openChannels.map(async (ch) => {
          try {
            const res = await authFetch(`${API_URL}/api/agents.list?channel=${ch}`);
            const data = await res.json();
            if (data.ok && data.agents) {
              result[ch] = data.agents
                .filter((a: any) => !a.is_sleeping)
                .map((a: any) => ({
                  agent_id: a.id || a.agent_id,
                  avatar_color: a.avatar_color || "#D97853",
                  is_sleeping: a.is_sleeping,
                }));
            }
          } catch {
            // ignore
          }
        }),
      );
      setChannelAgents(result);
    };
    fetchAllChannelAgents();
  }, [showChannelDialog, openChannels]);

  // Add current channel to stored list on mount (skip space channels)
  useEffect(() => {
    if (!initialChannel.includes(":")) {
      const updated = addStoredChannel(initialChannel);
      setOpenChannels(updated);
    }
  }, [initialChannel]);

  // Fetch space info when in space mode
  useEffect(() => {
    if (!isSpaceChannel || !spaceId) return;
    authFetch(`/api/spaces.get?id=${spaceId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.space)
          setSpaceInfo({
            title: data.space.title,
            status: data.space.status,
            channel: data.space.channel,
            card_message_ts: data.space.card_message_ts,
            agent_color: data.space.agent_color,
            agent_id: data.space.agent_id,
          });
        else setSpaceError(true);
      })
      .catch(() => setSpaceError(true));
  }, [isSpaceChannel, spaceId]);

  // Fetch worktree enabled state per channel
  useEffect(() => {
    if (isSpaceChannel) {
      setWorktreeEnabled(false);
      return;
    }
    authFetch(`/api/app.worktree.enabled?channel=${encodeURIComponent(activeChannel)}`)
      .then((res) => res.json())
      .then((data) => setWorktreeEnabled(data.ok && data.enabled === true))
      .catch(() => setWorktreeEnabled(false));
  }, [activeChannel, isSpaceChannel]);

  // Validate stored channels and remove inaccessible ones
  useEffect(() => {
    const validateChannels = async () => {
      const storedChannels = getStoredChannels();
      const accessibleChannels: string[] = [];

      for (const channel of storedChannels) {
        try {
          const res = await authFetch(`${API_URL}/api/conversations.history?channel=${channel}`);
          const data = await res.json();
          // Channel is accessible if API returns ok with messages or ok without error
          if (data.ok && data.messages && data.messages.length > 0) {
            accessibleChannels.push(channel);
          } else if (channel === activeChannel) {
            // Always keep current channel even if empty (might be new)
            accessibleChannels.push(channel);
          }
        } catch {
          // Keep current channel on network errors
          if (channel === activeChannel) {
            accessibleChannels.push(channel);
          }
        }
      }

      // Update localStorage and state with only accessible channels
      if (accessibleChannels.length !== storedChannels.length) {
        localStorage.setItem(CHANNELS_STORAGE_KEY, JSON.stringify(accessibleChannels));
        setOpenChannels(accessibleChannels);
      }
    };

    validateChannels();
  }, [activeChannel]); // Only run once on mount

  // Channel switcher functions - NO PAGE RELOAD
  const switchToChannel = useCallback(
    (targetChannel: string) => {
      setShowChannelDialog(false);
      if (targetChannel !== activeChannel) {
        // Initialize channel state if not exists
        setChannelStates((prev) => {
          if (!prev.has(targetChannel)) {
            const newMap = new Map(prev);
            newMap.set(targetChannel, { ...defaultChannelState });
            return newMap;
          }
          return prev;
        });
        // Update URL without reload
        window.history.pushState({}, "", `/${targetChannel}`);
        setActiveChannel(targetChannel);
        setIsActiveChannelAtBottom(true); // Assume at bottom when switching channels
      }
    },
    [activeChannel],
  );

  // Handle notification permission toggle
  const handleNotificationToggle = useCallback(async () => {
    if (!("Notification" in window)) return;
    if (Notification.permission === "denied") {
      // Can't re-request after deny - user must change in browser settings
      alert("Notifications are blocked. Please enable them in your browser settings.");
      return;
    }
    const granted = await requestNotificationPermission();
    setNotificationPermission(granted ? "granted" : "denied");
  }, []);

  const fetchAgentLastSeen = useCallback(
    async (channelId: string) => {
      try {
        const res = await authFetch(`${API_URL}/api/agent.getLastSeen?agent_id=${channelId}&channel=${channelId}`);
        const data = await res.json();
        if (data.ok && data.last_seen_ts) {
          updateChannelState(channelId, { agentLastSeenTs: data.last_seen_ts });
        }
      } catch (err) {
        console.error("Failed to fetch agent last seen:", err);
      }
    },
    [updateChannelState],
  );

  const fetchAgentStatus = useCallback(
    async (channelId: string) => {
      try {
        const res = await authFetch(`${API_URL}/api/channel.status?channel=${channelId}`);
        const data = await res.json();
        if (data.ok) {
          const isOffline = data.status === "offline";
          updateChannelState(channelId, {
            agentStatus: {
              status: isOffline ? "hibernate" : "ready",
              hibernate_until: null,
              auto_hibernate: isOffline,
            },
          });
        }
      } catch (err) {
        console.error("Failed to fetch agent status:", err);
      }
    },
    [updateChannelState],
  );

  // Fetch user's last seen timestamp for a channel
  const fetchUserLastSeen = useCallback(
    async (channelId: string) => {
      try {
        const res = await authFetch(`${API_URL}/api/user.getLastSeen?channel=${channelId}`);
        const data = await res.json();
        if (data.ok) {
          updateChannelState(channelId, { userLastSeenTs: data.last_seen_ts });
        }
      } catch (err) {
        console.error("Failed to fetch user last seen:", err);
      }
    },
    [updateChannelState],
  );

  // Fetch unread counts for all open channels
  const fetchUnreadCounts = useCallback(async () => {
    if (openChannels.length === 0) return;
    try {
      const res = await authFetch(`${API_URL}/api/user.getUnreadCounts?channels=${openChannels.join(",")}`);
      const data = await res.json();
      if (data.ok) {
        console.log("[UnreadCounts] Updated:", data.counts);
        setUnreadCounts(data.counts);
      }
    } catch (err) {
      console.error("Failed to fetch unread counts:", err);
    }
  }, [openChannels]);

  // Fetch and sync agent streaming status from server
  const fetchAgentStreamingStatus = useCallback(async (channelId: string) => {
    try {
      const res = await authFetch(`${API_URL}/api/agents.list?channel=${channelId}`);
      const data = await res.json();
      if (data.ok && data.agents) {
        setChannelStates((prev) => {
          const current = prev.get(channelId);
          if (!current) return prev;

          // Get currently streaming agents from server
          const serverStreaming = data.agents
            .filter((a: any) => a.is_streaming)
            .map((a: any) => ({
              agentId: a.id,
              avatarColor: a.avatar_color || "#D97853",
            }));

          // Sync streamingAgents list with server state
          const currentIds = current.streamingAgents
            .map((a) => a.agentId)
            .sort()
            .join(",");
          const serverIds = serverStreaming
            .map((a: any) => a.agentId)
            .sort()
            .join(",");
          if (currentIds === serverIds) return prev;

          // Mark stale streaming output as completed (don't delete -- dialog may be open)
          for (const [key, info] of streamingOutputRef.current.entries()) {
            if (key.startsWith(`${channelId}:`)) {
              const agentId = key.slice(channelId.length + 1);
              if (!serverStreaming.some((a: any) => a.agentId === agentId)) {
                info.completed = true;
              }
            }
          }

          // Collect agent IDs that the server no longer considers streaming
          const staleAgentIds = new Set(
            current.streamingAgents
              .map((a) => a.agentId)
              .filter((id) => !serverStreaming.some((a: any) => a.agentId === id)),
          );

          const newMap = new Map(prev);
          newMap.set(channelId, {
            ...current,
            streamingAgents: serverStreaming,
            // Clear is_streaming on messages from agents that are no longer streaming
            messages:
              staleAgentIds.size > 0
                ? current.messages.map((m) =>
                    m.agent_id && staleAgentIds.has(m.agent_id) && m.is_streaming ? { ...m, is_streaming: false } : m,
                  )
                : current.messages,
          });
          return newMap;
        });
      }
    } catch (err) {
      console.error("Failed to fetch agent streaming status:", err);
    }
  }, []);

  const fetchMessages = useCallback(
    async (channelId: string, background = false) => {
      try {
        const res = await authFetch(`${API_URL}/api/conversations.history?channel=${channelId}`);
        if (res.status === 401) {
          setAuthRequired(true);
          return;
        }
        const data = await res.json();
        if (data.ok) {
          if (data.messages.length === 0) {
            // Empty channel -- still valid, just no messages yet
            updateChannelState(channelId, {
              messages: [],
              hasMoreOlder: false,
              hasMoreNewer: false,
              isAtLatest: true,
              loaded: true,
            });
            setValidProject(true);
            return;
          }

          if (background) {
            // Background poll: merge new messages AND sync seen_by for existing messages
            setChannelStates((prev) => {
              const current = prev.get(channelId) || defaultChannelState;
              const existingTs = new Set(current.messages.map((m) => m.ts));
              const newMsgs = data.messages.filter((m: Message) => !existingTs.has(m.ts));

              // Build a map of ts -> seen_by from API response for quick lookup
              const apiSeenByMap = new Map<string, SeenByAgent[]>();
              const apiMessageTs = new Set<string>();
              for (const msg of data.messages as Message[]) {
                apiMessageTs.add(msg.ts);
                if (msg.seen_by && msg.seen_by.length > 0) {
                  apiSeenByMap.set(msg.ts, msg.seen_by);
                }
              }

              // Build set of agent IDs that have seen_by in API response
              // These agents should ONLY appear on their designated message
              const agentsInApiSeenBy = new Set<string>();
              for (const seenByList of apiSeenByMap.values()) {
                for (const s of seenByList) {
                  agentsInApiSeenBy.add(s.agent_id);
                }
              }

              // Check if any existing messages have different seen_by data
              let seenByChanged = false;
              for (const msg of current.messages) {
                const apiSeenBy = apiSeenByMap.get(msg.ts);
                const currentSeenBy = msg.seen_by || [];

                if (apiMessageTs.has(msg.ts)) {
                  // Message is in API response - compare seen_by directly
                  const currentIds = currentSeenBy
                    .map((s) => s.agent_id)
                    .sort()
                    .join(",");
                  const apiIds = (apiSeenBy || [])
                    .map((s) => s.agent_id)
                    .sort()
                    .join(",");
                  if (currentIds !== apiIds) {
                    seenByChanged = true;
                    break;
                  }
                } else {
                  // Message is NOT in API response (older) - check if any agents
                  // in current seen_by should be removed (they moved to newer msg)
                  const shouldRemove = currentSeenBy.some((s) => agentsInApiSeenBy.has(s.agent_id));
                  if (shouldRemove) {
                    seenByChanged = true;
                    break;
                  }
                }
              }

              if (newMsgs.length > 0 || seenByChanged) {
                if (newMsgs.length > 0) {
                  console.log(`[Poll ${channelId}] Found ${newMsgs.length} new message(s)`);
                }
                if (seenByChanged) {
                  console.log(`[Poll ${channelId}] Syncing seen_by data from API`);
                }
                // Play notification for background channel new bot messages
                if (!isInitialLoadRef.current.has(channelId)) {
                  for (const msg of newMsgs) {
                    if (isAgentMessage(msg)) {
                      playNotificationSound();
                      // Show desktop notification for the first new agent message
                      const agentName = msg.agent_id || "Claw'd";
                      const plainText = msg.text?.replace(/[*_`~#>[\]()!]/g, "").trim() || "New message";
                      showDesktopNotification(agentName, plainText, channelId);
                      break;
                    }
                  }
                }

                // Update existing messages with fresh seen_by data from API
                const updatedExisting = current.messages.map((m) => {
                  if (apiMessageTs.has(m.ts)) {
                    // Message is in API response - use API's seen_by (or empty)
                    const apiSeenBy = apiSeenByMap.get(m.ts);
                    return { ...m, seen_by: apiSeenBy || [] };
                  } else {
                    // Message is older than API response - remove agents that moved to newer
                    const currentSeenBy = m.seen_by || [];
                    const filtered = currentSeenBy.filter((s) => !agentsInApiSeenBy.has(s.agent_id));
                    return { ...m, seen_by: filtered };
                  }
                });

                const merged = [...updatedExisting, ...newMsgs].sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
                const newMap = new Map(prev);
                newMap.set(channelId, { ...current, messages: merged });
                return newMap;
              }
              return prev;
            });
          } else {
            updateChannelState(channelId, {
              messages: data.messages,
              hasMoreOlder: data.has_more || false,
              hasMoreNewer: false, // At latest when initially loaded
              isAtLatest: true,
              loaded: true,
            });
          }

          setValidProject(true);
        } else {
          // API returned error -- still show channel UI (don't redirect)
          setValidProject(true);
        }
      } catch (err) {
        console.error("Failed to fetch messages:", err);
        if (!background) {
          // Network error -- still show channel UI (don't redirect)
          setValidProject(true);
        }
      }
    },
    [updateChannelState],
  );

  const loadOlderMessages = useCallback(async () => {
    const current = channelStates.get(activeChannel);
    if (!current || current.loadingOlder || !current.hasMoreOlder || current.messages.length === 0) return;

    updateChannelState(activeChannel, { loadingOlder: true });
    try {
      const oldestTs = current.messages[0].ts;
      const res = await authFetch(`${API_URL}/api/conversations.history?channel=${activeChannel}&oldest=${oldestTs}`);
      const data = await res.json();

      if (data.ok && data.messages.length > 0) {
        setChannelStates((prev) => {
          const curr = prev.get(activeChannel) || defaultChannelState;
          const newMap = new Map(prev);
          newMap.set(activeChannel, {
            ...curr,
            messages: [...data.messages, ...curr.messages],
            hasMoreOlder: data.has_more || false,
            loadingOlder: false,
          });
          return newMap;
        });
      } else {
        updateChannelState(activeChannel, {
          hasMoreOlder: false,
          loadingOlder: false,
        });
      }
    } catch (err) {
      console.error("Failed to load older messages:", err);
      updateChannelState(activeChannel, { loadingOlder: false });
    }
  }, [activeChannel, channelStates, updateChannelState]);

  // Load newer messages (for scrolling down when viewing history)
  const loadNewerMessages = useCallback(async () => {
    const current = channelStates.get(activeChannel);
    if (!current || current.loadingNewer || !current.hasMoreNewer || current.messages.length === 0) return;

    updateChannelState(activeChannel, { loadingNewer: true });
    try {
      const newestTs = current.messages[current.messages.length - 1].ts;
      const res = await authFetch(`${API_URL}/api/conversations.newer?channel=${activeChannel}&newest=${newestTs}`);
      const data = await res.json();

      if (data.ok && data.messages.length > 0) {
        setChannelStates((prev) => {
          const curr = prev.get(activeChannel) || defaultChannelState;
          const newMap = new Map(prev);
          newMap.set(activeChannel, {
            ...curr,
            messages: [...curr.messages, ...data.messages],
            hasMoreNewer: data.has_more_newer || false,
            loadingNewer: false,
            // If no more newer messages, we've reached the latest
            isAtLatest: !data.has_more_newer,
          });
          return newMap;
        });
      } else {
        updateChannelState(activeChannel, {
          hasMoreNewer: false,
          loadingNewer: false,
          isAtLatest: true,
        });
      }
    } catch (err) {
      console.error("Failed to load newer messages:", err);
      updateChannelState(activeChannel, { loadingNewer: false });
    }
  }, [activeChannel, channelStates, updateChannelState]);

  // Jump to a specific message timestamp (for clicking @msg: references)
  const jumpToMessage = useCallback(
    async (ts: string): Promise<boolean> => {
      // First check if the message is already in the DOM
      const existingEl = document.getElementById(`msg-${ts}`);
      if (existingEl) {
        return true; // Message exists, MessageList will handle scrolling
      }

      // Message not in DOM - fetch messages around this timestamp
      try {
        const res = await authFetch(`${API_URL}/api/conversations.around?channel=${activeChannel}&ts=${ts}`);
        const data = await res.json();

        if (data.ok && data.messages.length > 0) {
          updateChannelState(activeChannel, {
            messages: data.messages,
            hasMoreOlder: data.has_more_older || false,
            hasMoreNewer: data.has_more_newer || false,
            isAtLatest: !data.has_more_newer,
            loadingOlder: false,
            loadingNewer: false,
          });
          return true; // Signal to MessageList that messages were loaded
        }
      } catch (err) {
        console.error("Failed to jump to message:", err);
      }
      return false;
    },
    [activeChannel, updateChannelState],
  );

  // Handle ?msg= URL parameter for jumping to a specific message on load
  const isChannelLoaded = currentState.loaded;
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const msgTs = params.get("msg");
    if (msgTs && isChannelLoaded) {
      setJumpToMessageTs(msgTs);
      jumpToMessage(msgTs);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [isChannelLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Jump to latest messages (scroll to bottom button)
  const jumpToLatest = useCallback(async () => {
    try {
      const res = await authFetch(`${API_URL}/api/conversations.history?channel=${activeChannel}&limit=100`);
      const data = await res.json();

      if (data.ok) {
        updateChannelState(activeChannel, {
          messages: data.messages,
          hasMoreOlder: data.has_more || false,
          hasMoreNewer: false,
          isAtLatest: true,
          loadingOlder: false,
          loadingNewer: false,
        });
      }
    } catch (err) {
      console.error("Failed to jump to latest:", err);
    }
  }, [activeChannel, updateChannelState]);

  // Subscribe to a channel via WebSocket
  const subscribeToChannel = useCallback((channelId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (subscribedChannelsRef.current.has(channelId)) return;

    wsRef.current.send(JSON.stringify({ type: "subscribe", channel: channelId }));
    subscribedChannelsRef.current.add(channelId);
    console.log(`[WS] Subscribed to ${channelId}`);
  }, []);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const token = getStoredAuthToken();
    const wsToken = token ? `&token=${encodeURIComponent(token)}` : "";
    const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws?user=UHUMAN${wsToken}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("[WS] Connected");
      setConnected(true);
      subscribedChannelsRef.current.clear();
      // Subscribe to all open channels (use ref for stable reference)
      openChannelsRef.current.forEach((ch) => {
        ws.send(JSON.stringify({ type: "subscribe", channel: ch }));
        subscribedChannelsRef.current.add(ch);
      });
      // Also subscribe to active channel if not in openChannels (e.g., sub-space channels)
      const active = activeChannelRef.current;
      if (active && !subscribedChannelsRef.current.has(active)) {
        ws.send(JSON.stringify({ type: "subscribe", channel: active }));
        subscribedChannelsRef.current.add(active);
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const msgChannel = data.channel || activeChannel;

        if (data.type === "message") {
          setChannelStates((prev) => {
            const current = prev.get(msgChannel);
            if (!current) return prev;
            if (current.messages.some((m) => m.ts === data.message.ts)) return prev;

            // Play sound for new messages from agent (always play for background channels)
            if (!isInitialLoadRef.current.has(msgChannel) && isAgentMessage(data.message)) {
              playNotificationSound();
              // Show desktop notification when tab is hidden
              const agentName = data.message.agent_id || "Claw'd";
              const plainText = data.message.text?.replace(/[*_`~#>[\]()!]/g, "").trim() || "New message";
              showDesktopNotification(agentName, plainText, msgChannel);
            }

            // If this is a user message, remove any 'sent' pending messages (they've been delivered)
            const isUserMessage = data.message.user === "UHUMAN";
            const updatedPending = isUserMessage
              ? current.pendingMessages.filter((m) => m.status !== "sent")
              : current.pendingMessages;

            const newMap = new Map(prev);
            newMap.set(msgChannel, {
              ...current,
              messages: [...current.messages, data.message],
              pendingMessages: updatedPending,
            });
            return newMap;
          });
          // Refetch unread counts when new message arrives (slight delay to ensure DB commit)
          setTimeout(() => fetchUnreadCounts(), 200);
        } else if (data.type === "message_changed") {
          updateChannelState(msgChannel, {
            messages: (channelStatesRef.current.get(msgChannel)?.messages || []).map((m) =>
              m.ts === data.message.ts
                ? {
                    ...data.message,
                    seen_by: m.seen_by || data.message.seen_by,
                  }
                : m,
            ),
          });
        } else if (data.type === "artifact_action") {
          // Mark interactive artifact as submitted (one-shot cross-user disable)
          if (data.one_shot) {
            updateChannelState(msgChannel, {
              messages: (channelStatesRef.current.get(msgChannel)?.messages || []).map((m) =>
                m.ts === data.message_ts ? { ...m, interactive_acted: true } : m,
              ),
            });
          }
        } else if (data.type === "message_seen") {
          setChannelStates((prev) => {
            const current = prev.get(msgChannel);
            if (!current) return prev;

            // Single-pass: only update the target message, leave others unchanged
            // This avoids O(n) object creation for each message_seen event
            let hasChange = false;
            const updated = current.messages.map((m) => {
              if (m.ts === data.message_ts) {
                // Target message - add agent to seen_by if not already there
                const seenBy = m.seen_by || [];
                if (!seenBy.some((s) => s.agent_id === data.agent_id)) {
                  hasChange = true;
                  return {
                    ...m,
                    seen_by: [
                      ...seenBy,
                      {
                        agent_id: data.agent_id,
                        avatar_color: data.avatar_color,
                        is_sleeping: data.is_sleeping,
                      },
                    ],
                  };
                }
              }
              // Return same object reference for unchanged messages
              return m;
            });

            if (!hasChange) return prev;

            const newMap = new Map(prev);
            newMap.set(msgChannel, { ...current, messages: updated });
            return newMap;
          });
        } else if (data.type === "agent_seen") {
          updateChannelState(msgChannel, {
            agentLastSeenTs: data.last_seen_ts,
          });
        } else if (data.type === "agent_poll") {
          // Consolidated poll event — combines agent_seen + message_seen + agent_status
          updateChannelState(msgChannel, {
            agentLastSeenTs: data.last_seen_ts,
            agentStatus: {
              status: data.status,
              hibernate_until: data.hibernate_until,
            },
          });
          // Update message seen_by if message_seen_ts is provided
          if (data.message_seen_ts) {
            setChannelStates((prev) => {
              const current = prev.get(msgChannel);
              if (!current) return prev;
              let hasChange = false;
              const updated = current.messages.map((m) => {
                if (m.ts === data.message_seen_ts) {
                  const seenBy = m.seen_by || [];
                  if (!seenBy.some((s: any) => s.agent_id === data.agent_id)) {
                    hasChange = true;
                    return {
                      ...m,
                      seen_by: [
                        ...seenBy,
                        {
                          agent_id: data.agent_id,
                          avatar_color: data.avatar_color || "#D97853",
                          is_sleeping: data.is_sleeping,
                        },
                      ],
                    };
                  }
                }
                return m;
              });
              if (!hasChange) return prev;
              const newMap = new Map(prev);
              newMap.set(msgChannel, { ...current, messages: updated });
              return newMap;
            });
          }
        } else if (data.type === "user_seen") {
          // Human user marked messages as seen
          updateChannelState(msgChannel, { userLastSeenTs: data.ts });
          // Refetch unread counts
          fetchUnreadCounts();
        } else if (data.type === "agent_status") {
          updateChannelState(msgChannel, {
            agentStatus: {
              status: data.status,
              hibernate_until: data.hibernate_until,
              auto_hibernate: data.auto_hibernate,
            },
          });
        } else if (data.type === "agent_token") {
          // Accumulate token into streaming output ref (no React re-render)
          const key = `${msgChannel}:${data.agent_id}`;
          let info = streamingOutputRef.current.get(key);
          if (!info) {
            info = {
              agentId: data.agent_id,
              avatarColor: data.avatar_color || "#D97853",
              entries: [],
            };
            streamingOutputRef.current.set(key, info);
          } else if (info.completed) {
            // Agent was previously completed but is streaming again -- add a session divider
            info.entries.push({
              type: "session_divider",
              text: "New streaming session",
              timestamp: Date.now(),
            });
            info.completed = false;
          }

          // Merge consecutive tokens of same type for efficiency
          const lastEntry = info.entries[info.entries.length - 1];
          const tokenType: StreamEntry["type"] =
            data.token_type === "thinking" ? "thinking" : data.token_type === "event" ? "event" : "content";
          if (lastEntry && lastEntry.type === tokenType && tokenType !== "event") {
            lastEntry.text += data.token;
          } else {
            info.entries.push({
              type: tokenType,
              text: data.token,
              timestamp: data.timestamp || Date.now(),
            });
          }
          streamingVersionRef.current++;

          // Ensure this agent is in the streamingAgents list (triggers render once)
          setChannelStates((prev) => {
            const current = prev.get(msgChannel) || { ...defaultChannelState };
            const alreadyTracked = current.streamingAgents.some((a) => a.agentId === data.agent_id);
            if (alreadyTracked) return prev;
            const newMap = new Map(prev);
            newMap.set(msgChannel, {
              ...current,
              streamingAgents: [
                ...current.streamingAgents,
                {
                  agentId: data.agent_id,
                  avatarColor: data.avatar_color || "#D97853",
                },
              ],
            });
            return newMap;
          });
        } else if (data.type === "agent_tool_call") {
          // Accumulate tool call into streaming output ref
          const key = `${msgChannel}:${data.agent_id}`;
          let info = streamingOutputRef.current.get(key);
          if (!info) {
            info = {
              agentId: data.agent_id,
              avatarColor: data.avatar_color || "#D97853",
              entries: [],
            };
            streamingOutputRef.current.set(key, info);
          } else if (info.completed) {
            // Agent was previously completed but is streaming again -- add a session divider
            info.entries.push({
              type: "session_divider",
              text: "New streaming session",
              timestamp: Date.now(),
            });
            info.completed = false;
          }

          const entryType =
            data.status === "error" ? "tool_error" : data.status === "completed" ? "tool_end" : "tool_start";
          info.entries.push({
            type: entryType,
            text: data.result || "",
            timestamp: data.timestamp || Date.now(),
            toolName: data.tool_name,
            toolArgs: data.tool_args,
          });
          streamingVersionRef.current++;

          // Ensure this agent is in the streamingAgents list
          setChannelStates((prev) => {
            const current = prev.get(msgChannel) || { ...defaultChannelState };
            const alreadyTracked = current.streamingAgents.some((a) => a.agentId === data.agent_id);
            if (alreadyTracked) return prev;
            const newMap = new Map(prev);
            newMap.set(msgChannel, {
              ...current,
              streamingAgents: [
                ...current.streamingAgents,
                {
                  agentId: data.agent_id,
                  avatarColor: data.avatar_color || "#D97853",
                },
              ],
            });
            return newMap;
          });
        } else if (data.type === "agent_streaming") {
          if (data.is_streaming) {
            // Agent started streaming - ensure tracked and mark as NOT sleeping
            setChannelStates((prev) => {
              const current = prev.get(msgChannel) || {
                ...defaultChannelState,
              };
              const alreadyTracked = current.streamingAgents.some((a) => a.agentId === data.agent_id);
              // Only map messages if any message has this agent in seen_by or as agent_id
              const agentId = data.agent_id;
              const hasAgent = current.messages.some(
                (m) => m.agent_id === agentId || m.seen_by?.some((s) => s.agent_id === agentId),
              );
              const newMap = new Map(prev);
              newMap.set(msgChannel, {
                ...current,
                streamingAgents: alreadyTracked
                  ? current.streamingAgents
                  : [
                      ...current.streamingAgents,
                      {
                        agentId: data.agent_id,
                        avatarColor: data.avatar_color || "#D97853",
                      },
                    ],
                // Clear sleeping status for this agent since it's actively streaming
                messages: hasAgent
                  ? current.messages.map((m) => ({
                      ...m,
                      is_sleeping: m.agent_id === agentId ? false : m.is_sleeping,
                      seen_by: m.seen_by?.map((s) => (s.agent_id === agentId ? { ...s, is_sleeping: false } : s)),
                    }))
                  : current.messages,
              });
              return newMap;
            });
          } else {
            // Agent stopped streaming - remove from active tracking but KEEP output entries
            // The dialog's cachedOutputRef handles display; entries are only fully cleared when dialog closes
            const key = `${msgChannel}:${data.agent_id}`;
            const info = streamingOutputRef.current.get(key);
            if (info) {
              info.completed = true; // Mark as completed, don't delete entries
            }
            streamingVersionRef.current++;

            updateChannelState(
              msgChannel,
              (() => {
                const current = channelStatesRef.current.get(msgChannel) || defaultChannelState;
                const agentId = data.agent_id;
                return {
                  streamingAgents: current.streamingAgents.filter((a) => a.agentId !== agentId),
                  // Remove legacy thinking placeholders and clear is_streaming on all messages
                  // from this agent so they render as normal completed messages.
                  messages: current.messages
                    .filter((m) => m.ts !== `thinking_${agentId}`)
                    .map((m) => (m.agent_id === agentId && m.is_streaming ? { ...m, is_streaming: false } : m)),
                };
              })(),
            );
          }
        } else if (data.type === "agent_sleep") {
          // Update is_sleeping status for this agent in seen_by arrays
          setChannelStates((prev) => {
            const current = prev.get(msgChannel);
            if (!current) return prev;

            // Early exit: only map if any message has this agent in seen_by or as agent_id
            const agentId = data.agent_id;
            const hasAgent = current.messages.some(
              (m) => m.agent_id === agentId || m.seen_by?.some((s) => s.agent_id === agentId),
            );
            if (!hasAgent) return prev;

            const newMap = new Map(prev);
            newMap.set(msgChannel, {
              ...current,
              messages: current.messages.map((m) => ({
                ...m,
                is_sleeping: m.agent_id === agentId ? data.is_sleeping : m.is_sleeping,
                seen_by: m.seen_by?.map((s) => (s.agent_id === agentId ? { ...s, is_sleeping: data.is_sleeping } : s)),
              })),
            });
            return newMap;
          });
        } else if (data.type === "agent_joined") {
          // New agent joined the channel - could update agent list UI
          console.log(`[WS] Agent joined: ${data.agent?.agent_id}`);
        } else if (data.type === "agent_processed") {
          // Agent processed a message - could update last activity indicator
          console.log(`[WS] Agent processed: ${data.agent_id}, ts=${data.last_processed_ts}`);
        } else if (data.type === "channel_cleared") {
          updateChannelState(msgChannel, { messages: [], pendingMessages: [] });
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onclose = () => {
      console.log("[WS] Disconnected");
      setConnected(false);
      wsRef.current = null;
      subscribedChannelsRef.current.clear();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = window.setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchUnreadCounts]); // Minimal deps - uses refs for openChannels

  // Initialize channel when it becomes active
  useEffect(() => {
    // Article mode skips normal channel initialization
    if (isArticleMode) return;
    // Use ref to avoid re-running effect on every channelStates change
    const state = channelStatesRef.current.get(activeChannel);
    if (!state?.loaded) {
      fetchMessages(activeChannel, false).then(() => {
        setTimeout(() => {
          isInitialLoadRef.current.add(activeChannel);
        }, 500);
      });
      fetchAgentLastSeen(activeChannel);
      fetchAgentStatus(activeChannel);
      fetchAgentStreamingStatus(activeChannel);
      fetchUserLastSeen(activeChannel);
    }

    // Subscribe to the channel if not already subscribed
    subscribeToChannel(activeChannel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannel]); // Only trigger on channel change, not state changes

  // Article mode: fetch article and inject as single message
  useEffect(() => {
    if (!isArticleMode || !articleId) return;
    (async () => {
      try {
        const res = await authFetch(`${API_URL}/api/articles.get?id=${encodeURIComponent(articleId)}`);
        const data = await res.json();
        if (data.ok && data.article) {
          const art = data.article;
          updateChannelState(activeChannel, {
            messages: [
              {
                ts: String(art.created_at),
                user: art.author || "Claw'd",
                text: art.content,
                agent_id: art.author || "clawd",
                avatar_color: art.avatar_color,
              },
            ],
            hasMoreOlder: false,
            hasMoreNewer: false,
            isAtLatest: true,
            loaded: true,
          });
          setValidProject(true);
        } else {
          setValidProject(true);
          updateChannelState(activeChannel, { messages: [], loaded: true });
        }
      } catch {
        setValidProject(true);
        updateChannelState(activeChannel, { messages: [], loaded: true });
      }
    })();
  }, [articleId, isArticleMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch unread counts on mount and when open channels change
  useEffect(() => {
    fetchUnreadCounts();
  }, [fetchUnreadCounts]);

  // Connect WebSocket on mount (skip in article mode — no real-time updates needed)
  useEffect(() => {
    if (isArticleMode) return;
    connectWebSocket();

    // Background polling for ALL open channels - 3 seconds (WebSocket handles real-time)
    pollIntervalRef.current = window.setInterval(() => {
      // Use refs for stable access without causing effect re-runs
      const channelsToPoll = new Set(openChannelsRef.current);
      // Also poll active channel if it's a space channel (not in openChannels)
      const active = activeChannelRef.current;
      if (active) channelsToPoll.add(active);

      channelsToPoll.forEach((ch) => {
        const state = channelStatesRef.current.get(ch);
        if (state?.loaded) {
          fetchMessages(ch, true);
          fetchAgentStatus(ch);
          fetchAgentStreamingStatus(ch);
        }
      });
      // Fetch unread counts
      fetchUnreadCounts();
    }, 10000); // Increased from 3s to 10s - WebSocket handles real-time updates

    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty deps - run only on mount, uses refs for state access

  const sendMessage = async (text: string, files?: File[]) => {
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pendingMsg: PendingMessage = {
      id: pendingId,
      text,
      files,
      status: "sending",
    };

    // Add pending message immediately (optimistic UI)
    setChannelStates((prev) => {
      const current = prev.get(activeChannel) || defaultChannelState;
      const newMap = new Map(prev);
      newMap.set(activeChannel, {
        ...current,
        pendingMessages: [...current.pendingMessages, pendingMsg],
      });
      return newMap;
    });

    try {
      // Upload files first if any
      const uploadedFiles: { id: string; name: string; url_private: string }[] = [];
      if (files && files.length > 0) {
        for (const file of files) {
          const formData = new FormData();
          formData.append("file", file);
          formData.append("channel", activeChannel);

          const uploadRes = await authFetch(`${API_URL}/api/files.upload`, {
            method: "POST",
            body: formData,
          });
          const uploadData = await uploadRes.json();
          if (uploadData.ok && uploadData.file) {
            uploadedFiles.push(uploadData.file);
          }
        }
      }

      const res = await authFetch(`${API_URL}/api/chat.postMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: activeChannel,
          text: text || "",
          user: "UHUMAN",
          files: uploadedFiles.length > 0 ? uploadedFiles : undefined,
        }),
      });
      const data = await res.json();

      if (data.ok) {
        // Remove pending message after 500ms delay (gives time for WebSocket to deliver real message)
        setTimeout(() => {
          setChannelStates((prev) => {
            const current = prev.get(activeChannel) || defaultChannelState;
            const newMap = new Map(prev);
            newMap.set(activeChannel, {
              ...current,
              pendingMessages: current.pendingMessages.filter((m) => m.id !== pendingId),
            });
            return newMap;
          });
        }, 500);
      }

      if (!data.ok) {
        console.error("Failed to send:", data.error);
        // Mark as failed
        setChannelStates((prev) => {
          const current = prev.get(activeChannel) || defaultChannelState;
          const newMap = new Map(prev);
          newMap.set(activeChannel, {
            ...current,
            pendingMessages: current.pendingMessages.map((m) =>
              m.id === pendingId ? { ...m, status: "failed" as const, error: data.error } : m,
            ),
          });
          return newMap;
        });
      }
    } catch (err) {
      console.error("Failed to send message:", err);
      // Mark as failed
      setChannelStates((prev) => {
        const current = prev.get(activeChannel) || defaultChannelState;
        const newMap = new Map(prev);
        newMap.set(activeChannel, {
          ...current,
          pendingMessages: current.pendingMessages.map((m) =>
            m.id === pendingId ? { ...m, status: "failed" as const, error: String(err) } : m,
          ),
        });
        return newMap;
      });
    }
  };

  // Retry/edit a failed message
  const retryMessage = useCallback(
    (pendingMsg: PendingMessage) => {
      // Remove from pending
      setChannelStates((prev) => {
        const current = prev.get(activeChannel) || defaultChannelState;
        const newMap = new Map(prev);
        newMap.set(activeChannel, {
          ...current,
          pendingMessages: current.pendingMessages.filter((m) => m.id !== pendingMsg.id),
        });
        return newMap;
      });
      // Return the message content for editing
      return { text: pendingMsg.text, files: pendingMsg.files };
    },
    [activeChannel],
  );

  // Callback to get streaming output for the dialog (reads from ref, no re-render)
  // NOTE: Must be before early returns to satisfy React's Rules of Hooks
  const getStreamingOutput = useCallback((): StreamingAgentInfo[] => {
    const results: StreamingAgentInfo[] = [];
    for (const [key, info] of streamingOutputRef.current.entries()) {
      if (key.startsWith(`${activeChannel}:`)) {
        results.push(info);
      }
    }
    return results;
  }, [activeChannel]);

  // Clear completed streaming output when dialog closes (prevents memory leak)
  const clearCompletedStreamingOutput = useCallback(() => {
    for (const [key, info] of streamingOutputRef.current.entries()) {
      if (key.startsWith(`${activeChannel}:`) && info.completed) {
        streamingOutputRef.current.delete(key);
      }
    }
  }, [activeChannel]);

  // Stable callback for marking messages as seen (passed to MessageList)
  const handleMarkSeen = useCallback(
    (ts: string) => {
      // Only update if ts is newer than current userLastSeenTs
      const current = channelStatesRef.current.get(activeChannel)?.userLastSeenTs;
      if (!current || ts > current) {
        // Optimistically update state immediately
        updateChannelState(activeChannel, { userLastSeenTs: ts });
        // Then sync to server
        authFetch(`${API_URL}/api/user.markSeen`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel: activeChannel, ts }),
        })
          .then(() => fetchUnreadCounts())
          .catch((err) => console.error("Failed to mark seen:", err));
      }
    },
    [activeChannel, updateChannelState, fetchUnreadCounts],
  );

  // Memoize recentAgents to avoid recomputing on every render
  const recentAgents = useMemo(
    () =>
      Array.from(
        new Map(
          messages
            .slice(-50)
            .flatMap((m) => m.seen_by || [])
            .map((agent) => [agent.agent_id, agent]),
        ).values(),
      ),
    [messages],
  );

  // Open thoughts dialog for a specific agent (loads historical entries from memory.db)
  const openAgentThoughts = useCallback(
    async (agentId: string, avatarColor: string) => {
      const key = `${activeChannel}:${agentId}`;
      const existing = streamingOutputRef.current.get(key);

      // If agent already has streaming entries, just open the dialog
      if (existing && existing.entries.length > 0) {
        setStreamDialogAgentId(agentId);
        setStreamDialogOpen(true);
        return;
      }

      // Fetch historical thoughts from server
      try {
        const res = await authFetch(
          `/api/agent.getThoughts?agent_id=${encodeURIComponent(agentId)}&channel=${encodeURIComponent(activeChannel)}&limit=200`,
        );
        const data = await res.json();
        if (data.ok && data.entries.length > 0) {
          streamingOutputRef.current.set(key, {
            agentId,
            avatarColor,
            entries: data.entries,
            completed: true,
          });
          streamingVersionRef.current++;
        }
      } catch {
        // Silently fail — dialog will show empty state
      }

      setStreamDialogAgentId(agentId);
      setStreamDialogOpen(true);
    },
    [activeChannel],
  );

  // Redirect to home if project is invalid
  // (We no longer redirect -- channels with no messages still show the channel UI)

  // Auth gate — show login prompt if server returned 401
  if (authRequired) {
    return (
      <LoginPrompt
        onLogin={(token) => {
          setStoredAuthToken(token);
          setAuthRequired(false);
          // Re-trigger initial load
          setValidProject(null);
        }}
      />
    );
  }

  // Loading state - Clawd running to header position
  if (validProject === null) {
    return (
      <div className="app loading">
        <header className="header">
          <div className="header-left">
            <div className="clawd-entrance">
              <svg width="28" height="22" viewBox="0 0 66 52" fill="none">
                <rect x="0" y="13" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
                <rect x="60" y="13" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
                <g className="leg1">
                  <rect x="6" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
                  <rect x="42" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
                </g>
                <g className="leg2">
                  <rect x="18" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
                  <rect x="54" y="39" width="6" height="13" fill="hsl(15 63.1% 59.6%)" />
                </g>
                <rect x="6" width="54" height="39" fill="hsl(15 63.1% 59.6%)" />
                <rect x="12" y="13" width="6" height="6.5" fill="#000" />
                <rect x="48" y="13" width="6" height="6.5" fill="#000" />
              </svg>
            </div>
          </div>
        </header>
      </div>
    );
  }

  // Compute active agents from recent messages (recentAgents is memoized above)
  const activeAgents = recentAgents.filter((a) => !a.is_sleeping);
  const allAgentsSleeping = recentAgents.length > 0 && activeAgents.length === 0;

  const isOffline = agentStatus.status === "hibernate";

  // Show offline banner when all agents are sleeping OR when channel status is hibernate
  // But never show it while an agent is actively streaming (streaming = not sleeping)
  const showOfflineBanner = (allAgentsSleeping || isOffline) && streamingAgents.length === 0;

  // Check if any OTHER channel has unread messages (header logo red dot)
  const hasAnyUnread = Object.entries(unreadCounts).some(([ch, count]) => ch !== activeChannel && count > 0);

  // Check if the active channel has unread messages (scroll-down button red dot)
  const hasActiveChannelUnread = !isActiveChannelAtBottom && (unreadCounts[activeChannel] || 0) > 0;

  return (
    <div className="app" data-article-mode={isArticleMode || undefined}>
      <header className="header">
        <div className="header-left">
          {isArticleMode ? (
            <div className="clawd-logo-wrapper">
              <ClawdLogo sleeping={false} hasUnread={false} />
            </div>
          ) : isSpaceChannel && parentChannel ? (
            <>
              <button
                className="clawd-logo-button"
                onClick={() => {
                  const ts = spaceInfo?.card_message_ts;
                  window.location.href = ts ? `/${parentChannel}?msg=${ts}` : `/${parentChannel}`;
                }}
                title="Back to channel"
              >
                <ClawdLogo sleeping={false} hasUnread={false} />
              </button>
              <span className="header-channel-name">
                {parentChannel}
                {spaceInfo?.agent_id ? ` | ${spaceInfo.agent_id}` : ""}
              </span>
            </>
          ) : (
            <>
              <button
                className="clawd-logo-button"
                onClick={() => {
                  window.location.pathname = "/";
                }}
                title="Home"
              >
                <ClawdLogo sleeping={isOffline && streamingAgents.length === 0} hasUnread={hasAnyUnread} />
              </button>
              <span className="header-channel-name">{displayName}</span>
            </>
          )}
        </div>
        {!isArticleMode && (
          <div className="header-right">
            {/* Notification permission toggle - hidden once granted */}
            {"Notification" in window && notificationPermission !== "granted" && (
              <button
                className="notification-toggle"
                onClick={handleNotificationToggle}
                title={
                  notificationPermission === "denied"
                    ? "Notifications blocked - enable in browser settings"
                    : "Enable desktop notifications"
                }
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  <line x1="1" y1="1" x2="23" y2="23" strokeWidth="2" />
                </svg>
              </button>
            )}
            <div className="online-agents">
              {/* Only show active (not sleeping) agents - sorted by agent_id */}
              {[...activeAgents]
                .sort((a, b) => a.agent_id.localeCompare(b.agent_id))
                .map((agent) => (
                  <div
                    key={agent.agent_id}
                    className="online-agent clickable"
                    title={`${agent.agent_id} — click to see thoughts`}
                    onClick={() => openAgentThoughts(agent.agent_id, agent.avatar_color)}
                  >
                    <AgentAvatarSmall color={agent.avatar_color} />
                  </div>
                ))}
            </div>
            {!isSpaceChannel && !isManagementChannel && (
              <div
                className={`connection-indicator ${!connected ? "reconnecting" : ""} clickable`}
                title="Agent"
                onClick={() => setShowAgentDialog(true)}
              >
                <CopilotLogo />
              </div>
            )}
          </div>
        )}
      </header>

      {/* Channel list dialog - triggered by logo click */}
      {showChannelDialog && (
        <div className="modal-overlay channel-dialog-overlay" onClick={() => setShowChannelDialog(false)}>
          <div className="channel-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="channel-dialog-header">
              <span className="channel-dialog-title">Spaces</span>
              <button
                className="channel-dialog-plus-btn"
                onClick={() => {
                  window.location.href = "/";
                }}
                title="Join new channel"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="channel-dialog-list">
              {/* Current channel - highlighted, non-interactive */}
              <div className="channel-dialog-item active">
                <span className="channel-dialog-item-name">{activeChannel}</span>
                <div className="channel-dialog-item-meta">
                  {(channelAgents[activeChannel] || []).length > 0 && (
                    <div className="channel-dialog-agents">
                      {(channelAgents[activeChannel] || []).map((agent) => (
                        <AgentAvatarSmall key={agent.agent_id} color={agent.avatar_color} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {/* Other channels - swipeable to remove */}
              {openChannels
                .filter((ch) => ch !== activeChannel)
                .map((ch) => (
                  <ChannelDialogSwipeRow
                    key={ch}
                    channel={ch}
                    agents={channelAgents[ch] || []}
                    unreadCount={unreadCounts[ch] || 0}
                    onSwitch={() => switchToChannel(ch)}
                    onRemove={() => {
                      const updated = removeStoredChannel(ch);
                      setOpenChannels(updated);
                    }}
                  />
                ))}
            </div>
          </div>
        </div>
      )}

      {isSpaceChannel && spaceError && (
        <div className="space-locked-banner">
          Sub-space not found.{" "}
          <button className="space-back-btn" onClick={() => (window.location.href = `/${parentChannel}`)}>
            ← Back to channel
          </button>
        </div>
      )}
      {isManagementChannel ? (
        <div className="messages-wrapper">
          <div className="messages">{activeChannel === "agents" ? <AgentFilesChannel /> : <SkillFilesChannel />}</div>
        </div>
      ) : (
        <>
          <div className="messages-wrapper">
            <MessageList
              messages={messages}
              pendingMessages={pendingMessages}
              agentLastSeenTs={agentLastSeenTs}
              userLastSeenTs={userLastSeenTs}
              channel={activeChannel}
              agentSleeping={isOffline && streamingAgents.length === 0}
              streamingAgentIds={streamingAgents.map((a) => a.agentId)}
              hasMoreOlder={hasMoreOlder}
              hasMoreNewer={hasMoreNewer}
              loadingOlder={loadingOlder}
              loadingNewer={loadingNewer}
              isAtLatest={isAtLatest}
              onLoadOlder={loadOlderMessages}
              onLoadNewer={loadNewerMessages}
              onJumpToMessage={jumpToMessage}
              onJumpToLatest={jumpToLatest}
              onMarkSeen={handleMarkSeen}
              channelKey={activeChannel}
              jumpToMessageTs={jumpToMessageTs}
              onJumpComplete={() => setJumpToMessageTs(null)}
              onRetryMessage={(msg) => {
                const { text, files } = retryMessage(msg);
                // Dispatch event to populate composer with failed message content
                window.dispatchEvent(new CustomEvent("restore-draft", { detail: { text, files } }));
              }}
              onScrollAtBottomChange={setIsActiveChannelAtBottom}
              hasActiveChannelUnread={hasActiveChannelUnread}
              onOpenSidebar={openSidebar}
            />
          </div>
          {sidebarContent && (
            <SidebarPanel
              isOpen={sidebarOpen}
              onClose={closeSidebar}
              title={sidebarContent.title}
              type={sidebarContent.type}
              url={sidebarContent.url}
              content={sidebarContent.content}
              artifactType={sidebarContent.artifactType}
              language={sidebarContent.language}
              fileType={sidebarContent.fileType}
            />
          )}
        </>
      )}
      {!isArticleMode && !isManagementChannel && (
        <MessageComposer
          onSend={sendMessage}
          channel={activeChannel}
          disabled={!channelStates.get(activeChannel)?.loaded || (isSpaceChannel && isSpaceLocked)}
          thinkingBanner={
            streamingAgents.length > 0 ? (
              <div
                className="thinking-banner"
                onClick={() => {
                  setStreamDialogAgentId(null);
                  setStreamDialogOpen(true);
                }}
                title="Click to see thoughts"
              >
                <div className="thinking-clawd">
                  <ClawdLogo />
                </div>
                <span>Thinking...</span>
              </div>
            ) : null
          }
          hibernateBanner={
            showOfflineBanner ? (
              <div className="hibernate-banner">
                <div className="sleeping-clawd">
                  <ClawdLogo sleeping={true} />
                </div>
                <span>Sleeping...</span>
              </div>
            ) : null
          }
          searchButton={
            <button className="search-btn" onClick={() => setShowSearchModal(true)} title="Search Messages">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
            </button>
          }
          projectsButton={
            recentAgents.length > 0 ? (
              <button className="projects-btn" onClick={() => setShowProjectsDialog(true)} title="Browse Project Files">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                </svg>
              </button>
            ) : undefined
          }
          mcpButton={
            !isSpaceChannel ? (
              <button className="mcp-btn" onClick={() => setShowMcpDialog(true)} title="MCP Servers">
                <McpIcon size={16} />
              </button>
            ) : undefined
          }
          skillsButton={
            !isSpaceChannel && recentAgents.length > 0 ? (
              <button className="skills-btn" onClick={() => setShowSkillsDialog(true)} title="Skills">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26" />
                </svg>
              </button>
            ) : undefined
          }
          worktreeButton={
            !isSpaceChannel && worktreeEnabled ? (
              <button className="worktree-btn" onClick={() => setShowWorktreeDialog(true)} title="Git">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
              </button>
            ) : undefined
          }
          onPlanClick={() => setShowPlanModal(true)}
        />
      )}
      <StreamOutputDialog
        open={streamDialogOpen}
        onClose={() => {
          setStreamDialogOpen(false);
          setStreamDialogAgentId(null);
          clearCompletedStreamingOutput();
        }}
        getStreamingOutput={getStreamingOutput}
        streamingVersion={streamingVersionRef}
        streamingAgents={streamingAgents}
        initialAgentId={streamDialogAgentId}
      />
      <TodoDialog channel={activeChannel} isOpen={showPlanModal} onClose={() => setShowPlanModal(false)} />
      <SearchModal
        messages={messages}
        channel={activeChannel}
        isOpen={showSearchModal}
        onClose={() => setShowSearchModal(false)}
        onJumpToMessage={async (ts) => {
          setShowSearchModal(false);
          // First fetch messages around this timestamp if needed
          const success = await jumpToMessage(ts);
          if (success) {
            // Give DOM time to update, then trigger scroll
            setTimeout(() => setJumpToMessageTs(ts), 100);
          }
        }}
      />
      <AgentDialog channel={activeChannel} isOpen={showAgentDialog} onClose={() => setShowAgentDialog(false)} />
      <McpDialog channel={activeChannel} isOpen={showMcpDialog} onClose={() => setShowMcpDialog(false)} />
      <SkillsDialog channel={activeChannel} isOpen={showSkillsDialog} onClose={() => setShowSkillsDialog(false)} />
      <ProjectsDialog
        channel={activeChannel}
        isOpen={showProjectsDialog}
        onClose={() => {
          setShowProjectsDialog(false);
          setProjectsInitialAgent(null);
          setProjectsInitialFile(null);
          setProjectsInitialLine(null);
        }}
        initialAgentId={projectsInitialAgent}
        initialFile={projectsInitialFile}
        initialLine={projectsInitialLine}
      />
      <WorktreeDialog
        channel={activeChannel}
        isOpen={showWorktreeDialog}
        onClose={() => setShowWorktreeDialog(false)}
        onOpenInProjects={(agentId, filePath, line) => {
          setShowWorktreeDialog(false);
          setProjectsInitialAgent(agentId || null);
          setProjectsInitialFile(filePath || null);
          setProjectsInitialLine(line ?? null);
          setShowProjectsDialog(true);
        }}
      />
    </div>
  );
}
