import { contextBridge, ipcRenderer } from "electron";
import type { AppSnapshotV2 } from "../shared/types.js";

const api = {
  getState: (): Promise<AppSnapshotV2> => ipcRenderer.invoke("state:get"),
  onStateChanged: (listener: (snapshot: AppSnapshotV2) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshotV2) => {
      listener(snapshot);
    };
    ipcRenderer.on("state:changed", handler);
    return () => ipcRenderer.removeListener("state:changed", handler);
  },
  refresh: (): Promise<AppSnapshotV2> => ipcRenderer.invoke("state:refresh"),
  setThreadEnabled: (threadId: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("thread:set-enabled", threadId, enabled),
  removeThread: (threadId: string): Promise<void> =>
    ipcRenderer.invoke("thread:remove", threadId),
  clearLocalData: (): Promise<void> => ipcRenderer.invoke("privacy:clear-data"),
  quit: (): Promise<boolean> => ipcRenderer.invoke("app:quit"),
};

contextBridge.exposeInMainWorld("resumeManager", api);
