const { contextBridge } = require("electron");

const now = Date.now();
const resetFiveHours = now + 52 * 60_000;
const resetWeek = now + 4 * 24 * 60 * 60_000 + 7 * 60 * 60_000;

const snapshot = {
  runtime: {
    status: "ready",
    codexPath: "/opt/homebrew/bin/codex",
    codexVersion: "codex-cli 0.142.5",
    appServerConnected: true,
    activeTaskId: null,
    activePid: null,
    lastQuotaCheckAt: new Date(now).toISOString(),
    lastError: null,
  },
  state: {
    version: 2,
    updatedAt: now,
    completedResumeKeys: [],
    quota: {
      capturedAt: now,
      rateLimitReachedType: null,
      primary: {
        name: "primary",
        usedPercent: 77,
        remainingPercent: 23,
        windowDurationMins: 300,
        resetsAt: resetFiveHours,
      },
      secondary: {
        name: "secondary",
        usedPercent: 30,
        remainingPercent: 70,
        windowDurationMins: 10_080,
        resetsAt: resetWeek,
      },
    },
    watchedThreads: [
      {
        threadId: "019f-preview-waiting",
        cwd: "/tmp/codex-resume-demo/project-alpha",
        title: "完成离线恢复体验",
        codexVersion: "codex-cli 0.142.5",
        enabled: true,
        status: "waiting_quota",
        quotaWait: {
          failedTurnId: "turn-quota",
          blockedWindows: [],
          resumeAfter: resetFiveHours + 60_000,
          attemptCount: 1,
          idempotencyKey: "preview-waiting-key",
        },
        resumeAttempt: null,
        lastObservedTurnId: "turn-quota",
        attentionReason: null,
        registeredAt: now - 3_600_000,
        updatedAt: now - 30_000,
      },
      {
        threadId: "019f-preview-watching",
        cwd: "/tmp/codex-resume-demo/project-beta",
        title: "验证自动续跑与额度状态",
        codexVersion: "codex-cli 0.142.5",
        enabled: true,
        status: "watching",
        quotaWait: null,
        resumeAttempt: null,
        lastObservedTurnId: "turn-current",
        attentionReason: null,
        registeredAt: now - 2_400_000,
        updatedAt: now - 90_000,
      },
      {
        threadId: "019f-preview-attention",
        cwd: "/tmp/codex-resume-demo/project-gamma",
        title: "整理导出流程的错误状态",
        codexVersion: "codex-cli 0.142.5",
        enabled: false,
        status: "needs_attention",
        quotaWait: null,
        resumeAttempt: null,
        lastObservedTurnId: "turn-external",
        attentionReason: "检测到你已从 Codex 手动继续；为避免重复执行，自动续跑已暂停。",
        registeredAt: now - 1_800_000,
        updatedAt: now - 600_000,
      },
    ],
  },
};

contextBridge.exposeInMainWorld("resumeManager", {
  getState: async () => snapshot,
  onStateChanged: () => () => undefined,
  refresh: async () => snapshot,
  setThreadEnabled: async () => undefined,
  removeThread: async () => undefined,
  quit: async () => undefined,
});
