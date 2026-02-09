import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import HomePage from "./HomePage";
import SettingsPage from "./SettingsPage";
import "./styles.css";

// Register Service Worker for PWA + desktop notifications
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
        });
        console.log("[SW] Registered:", registration.scope);

        // Check for updates periodically
        setInterval(
          () => {
            registration.update();
          },
          60 * 60 * 1000,
        ); // Check every hour
      } catch (error) {
        console.error("[SW] Registration failed:", error);
      }
    });
  }
}

registerServiceWorker();

// Simple path-based routing
function Router() {
  const path = window.location.pathname;

  // Settings page
  if (path === "/settings" || path === "/settings/") {
    return <SettingsPage />;
  }

  // Match both patterns:
  // - /spaces/{channel-id} (legacy)
  // - /{channel-id} (new, direct)
  const spaceMatch = path.match(/^\/spaces\/([^/]+)\/?$/) || path.match(/^\/([^/]+)\/?$/);

  if (spaceMatch) {
    const channel = spaceMatch[1];
    // Skip non-channel paths
    if (channel && !["favicon.ico", "assets", "api", "ws", "mcp", "health", "settings"].includes(channel)) {
      return <App channel={channel} />;
    }
  }

  // Home page (root or any other path)
  return <HomePage />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Router />
  </React.StrictMode>,
);
