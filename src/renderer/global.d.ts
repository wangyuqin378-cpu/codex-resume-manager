import type { AppSnapshotV2 } from "../shared/types.js";

declare global {
  interface Window {
    resumeManager: {
      getState(): Promise<AppSnapshotV2>;
      onStateChanged(listener: (snapshot: AppSnapshotV2) => void): () => void;
      refresh(): Promise<AppSnapshotV2 | void>;
      setThreadEnabled(threadId: string, enabled: boolean): Promise<void>;
      removeThread(threadId: string): Promise<void>;
      clearLocalData(): Promise<void>;
      quit(): Promise<boolean | void>;
    };
  }
}

export {};
