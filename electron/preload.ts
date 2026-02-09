/**
 * Electron Preload Script
 *
 * Runs in the renderer process before the web page loads.
 * Exposes a safe bridge API via contextBridge.
 */

import { contextBridge, ipcRenderer } from "electron";

// Expose a minimal API to the renderer
contextBridge.exposeInMainWorld("electronAPI", {
  // Platform info
  platform: process.platform,
  isElectron: true,

  // Window controls
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),

  // App info
  getVersion: () => ipcRenderer.invoke("app:version"),
});
