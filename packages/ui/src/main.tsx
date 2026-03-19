import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import HomePage from "./HomePage";
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

  // Match article paths: /articles/{id} — render App in article mode
  const articleMatch = path.match(/^\/articles\/([^/]+)\/?$/);
  if (articleMatch) {
    return <App channel="articles" articleId={articleMatch[1]} />;
  }

  // Match sub-space paths: /{channel}/{spaceId}
  const spacePageMatch = path.match(/^\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
  if (spacePageMatch) {
    const parentChannel = spacePageMatch[1];
    const spaceId = spacePageMatch[2];
    const spaceChannel = `${parentChannel}:${spaceId}`;
    return <App channel={spaceChannel} />;
  }

  // Match channel paths: /{channel}
  const spaceMatch = path.match(/^\/([^/]+)\/?$/);

  if (spaceMatch) {
    const channel = spaceMatch[1];
    // Skip non-channel paths
    if (channel && !["favicon.ico", "assets", "api", "ws", "mcp", "health"].includes(channel)) {
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
