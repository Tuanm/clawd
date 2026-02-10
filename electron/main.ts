/**
 * Electron Main Process
 *
 * Launches the Bun backend server as a child process, then opens
 * a BrowserWindow pointing at it. Handles native window lifecycle,
 * tray icon, and graceful shutdown.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from "electron";

// ============================================================================
// Configuration
// ============================================================================

const PORT = process.env.CLAWD_PORT || "3456";
const SERVER_URL = `http://localhost:${PORT}`;
const IS_DEV = process.env.NODE_ENV === "development";

// ============================================================================
// Paths
// ============================================================================

function getServerBinary(): string {
  if (IS_DEV) {
    // Dev mode: use bun to run the source directly
    return "";
  }

  // Production: look for the compiled server binary
  const resourcesPath = process.resourcesPath || dirname(app.getPath("exe"));

  // Check common locations
  const candidates = [
    join(resourcesPath, "server", "clawd-app"),
    join(resourcesPath, "clawd-app"),
    join(dirname(app.getPath("exe")), "server", "clawd-app"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  console.error("[Electron] Server binary not found in:", candidates);
  return candidates[0]; // Return first candidate, will fail with useful error
}

function getServerUiDir(): string {
  if (IS_DEV) {
    return join(__dirname, "..", "..", "packages", "ui", "dist");
  }

  const resourcesPath = process.resourcesPath || dirname(app.getPath("exe"));
  const candidates = [
    join(resourcesPath, "server", "ui"),
    join(resourcesPath, "ui"),
    join(dirname(app.getPath("exe")), "server", "ui"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  return candidates[0];
}

// ============================================================================
// Server Process
// ============================================================================

let serverProcess: ChildProcess | null = null;

function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Server failed to start within 15s"));
    }, 15_000);

    if (IS_DEV) {
      // Dev mode: spawn bun run dev
      const projectRoot = join(__dirname, "..", "..");
      serverProcess = spawn("bun", ["run", "src/index.ts", "--no-browser"], {
        cwd: projectRoot,
        env: {
          ...process.env,
          CHAT_PORT: PORT,
          UI_DIR: getServerUiDir(),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      // Production: spawn the compiled binary
      const serverBin = getServerBinary();
      const uiDir = getServerUiDir();

      serverProcess = spawn(serverBin, ["--port", PORT, "--no-browser"], {
        env: {
          ...process.env,
          UI_DIR: uiDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    }

    serverProcess.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      process.stdout.write(`[Server] ${text}`);
      // Resolve when server is ready (it prints the startup banner)
      if (text.includes("localhost:") || text.includes("Claw'd App")) {
        clearTimeout(timeout);
        // Give server a moment to fully bind
        setTimeout(resolve, 500);
      }
    });

    serverProcess.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[Server] ${data.toString()}`);
    });

    serverProcess.on("error", (err) => {
      clearTimeout(timeout);
      console.error("[Electron] Failed to start server:", err);
      reject(err);
    });

    serverProcess.on("exit", (code) => {
      console.log(`[Electron] Server process exited with code ${code}`);
      serverProcess = null;
    });
  });
}

async function waitForServer(maxRetries = 30): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      const data = (await res.json()) as { ok?: boolean };
      if (data.ok) return true;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function stopServer(): void {
  if (serverProcess) {
    console.log("[Electron] Stopping server...");
    serverProcess.kill("SIGTERM");

    // Force kill after 5s if it doesn't stop
    const forceKill = setTimeout(() => {
      if (serverProcess) {
        console.log("[Electron] Force killing server...");
        serverProcess.kill("SIGKILL");
      }
    }, 5000);

    serverProcess.on("exit", () => {
      clearTimeout(forceKill);
      serverProcess = null;
    });
  }
}

// ============================================================================
// Window Management
// ============================================================================

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: "Claw'd",
    titleBarStyle: platform() === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#1a1a2e",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, "preload.cjs"),
    },
  });

  // Load the server URL
  mainWindow.loadURL(SERVER_URL);

  // Show window when ready
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Handle external links -- open in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://localhost") || url.startsWith(SERVER_URL)) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  // macOS: hide window instead of closing (close to tray)
  mainWindow.on("close", (event) => {
    if (!isQuitting && platform() === "darwin") {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ============================================================================
// Application Menu
// ============================================================================

function createMenu(): void {
  const isMac = platform() === "darwin";

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [
              { type: "separator" as const },
              { role: "front" as const },
              { type: "separator" as const },
              { role: "window" as const },
            ]
          : [{ role: "close" as const }]),
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ============================================================================
// Tray Icon (macOS / Linux)
// ============================================================================

function createTray(): void {
  // Create a simple tray icon
  const canvas = nativeImage.createEmpty();

  // Use a simple template image for macOS
  tray = new Tray(canvas);

  tray.setToolTip("Claw'd");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show Claw'd",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    }
  });
}

// ============================================================================
// IPC Handlers
// ============================================================================

ipcMain.on("window:minimize", () => mainWindow?.minimize());
ipcMain.on("window:maximize", () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on("window:close", () => mainWindow?.close());
ipcMain.handle("app:version", () => app.getVersion());

// ============================================================================
// App Lifecycle
// ============================================================================

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // Focus existing window if a second instance is launched
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on("ready", async () => {
    console.log("[Electron] App ready, starting server...");

    try {
      await startServer();
      console.log("[Electron] Server started, waiting for health check...");

      const ready = await waitForServer();
      if (!ready) {
        console.error("[Electron] Server health check failed");
        app.quit();
        return;
      }

      console.log("[Electron] Server is healthy, creating window...");
      createMenu();
      createWindow();
      createTray();
    } catch (err) {
      console.error("[Electron] Startup error:", err);
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    if (platform() !== "darwin") {
      isQuitting = true;
      app.quit();
    }
  });

  app.on("activate", () => {
    // macOS: re-create window when dock icon is clicked
    if (mainWindow === null) {
      createWindow();
    } else {
      mainWindow.show();
    }
  });

  app.on("before-quit", () => {
    isQuitting = true;
    stopServer();
  });
}



