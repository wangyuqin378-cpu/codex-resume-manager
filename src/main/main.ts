import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
} from "electron";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CodexAppServerClient } from "./codex-app-server.js";
import { codexChildEnvironment } from "./codex-environment.js";
import { resolveCodexPath } from "./codex-path.js";
import { CommandInbox, type GuardianCommand } from "./command-inbox.js";
import { ThreadGuardian } from "./thread-guardian.js";
import { classifyQuotaWindowDuration } from "../core/quota.js";
import {
  createEmptyStateV2,
  guardianEventMessage,
  type AppSnapshotV2,
  type AppStateV2,
  type RuntimeHealth,
  type QuotaWindow,
  type WatchedThreadStatus,
} from "../shared/types.js";

const BACKGROUND_ARGUMENTS = new Set(["--background", "--process-command-inbox"]);
const QUOTA_REFRESH_INTERVAL_MS = 60_000;
const ARTIFACT_CLEANUP_INTERVAL_MS = 10 * 60_000;
const ACKNOWLEDGEMENT_RETENTION_MS = 60 * 60_000;
const DEAD_LETTER_RETENTION_MS = 7 * 24 * 60 * 60_000;
const AUTO_RESUME_PLUGIN_ID = "codex-auto-resume";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let guardian: ThreadGuardian | null = null;
let appServer: CodexAppServerClient | null = null;
let commandInbox: CommandInbox | null = null;
let isQuitting = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;
let refreshPromise: Promise<AppSnapshotV2> | null = null;
let quotaRefreshPromise: Promise<AppSnapshotV2> | null = null;
let quotaRefreshTimer: NodeJS.Timeout | null = null;
let artifactCleanupTimer: NodeJS.Timeout | null = null;
let hasSeenInitialGuardianState = false;
let previousStatuses = new Map<string, WatchedThreadStatus>();
let guardianMutationTail: Promise<void> = Promise.resolve();

const codexPath = resolveCodexPath();
const runtime: RuntimeHealth = {
  status: "starting",
  codexPath,
  codexVersion: null,
  appServerConnected: false,
  activeTaskId: null,
  activePid: null,
  lastQuotaCheckAt: null,
  lastError: null,
  hookStatus: "checking",
  hookMessage: null,
  loginItemEnabled: null,
  notificationsSupported: Notification.isSupported(),
  lastGuardianCheckAt: null,
};

function isBackgroundLaunch(argv: readonly string[] = process.argv): boolean {
  return argv.some((argument) => BACKGROUND_ARGUMENTS.has(argument));
}

function snapshot(): AppSnapshotV2 {
  const state = guardian?.getState() ?? createEmptyStateV2();
  return {
    state: {
      ...state,
      completedResumeKeys: [],
      events: (state.events ?? []).map((event) => ({
        ...event,
        turnId: null,
        message: guardianEventMessage(event.type),
      })),
      watchedThreads: state.watchedThreads.map((thread) => ({
        ...thread,
        cwd: "",
        title: null,
        quotaWait: thread.quotaWait === null
          ? null
          : {
              ...thread.quotaWait,
              failedTurnId: "",
              idempotencyKey: "",
            },
        resumeAttempt: thread.resumeAttempt === null
          ? null
          : {
              ...thread.resumeAttempt,
              key: "",
              failedTurnId: "",
              startedTurnId: null,
            },
        lastObservedTurnId: null,
        goalObjective: null,
        lastResult: null,
        controlTurnIds: [],
        attentionReason: null,
      })),
    },
    runtime: {
      ...structuredClone(runtime),
      codexPath: "codex",
      activeTaskId: null,
      activePid: null,
      lastError: runtime.lastError === null
        ? null
        : "本机守护暂时不可用；为避免重复执行，自动续跑已安全暂停并会继续重试。",
      hookMessage: null,
    },
  };
}

function broadcast(): AppSnapshotV2 {
  const current = snapshot();
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("state:changed", current);
  }
  updateTray(current);
  return current;
}

function syncRuntime(state: AppStateV2): void {
  runtime.activeTaskId = state.watchedThreads.find(
    (thread) => thread.status === "resuming",
  )?.threadId ?? null;
}

function handleGuardianState(state: AppStateV2): void {
  syncRuntime(state);
  if (hasSeenInitialGuardianState) {
    notifyTransitions(state);
  } else {
    hasSeenInitialGuardianState = true;
  }
  previousStatuses = new Map(
    state.watchedThreads.map((thread) => [thread.threadId, thread.status]),
  );
  broadcast();
}

function notifyTransitions(state: AppStateV2): void {
  if (!Notification.isSupported()) {
    return;
  }
  for (const thread of state.watchedThreads) {
    const previous = previousStatuses.get(thread.threadId);
    if (previous === undefined || previous === thread.status) {
      continue;
    }
    const title = "Codex 自动续跑";
    let body: string | null = null;
    if (thread.status === "waiting_quota_data") {
      body = "已确认额度中断，正在等待 Codex 提供准确刷新时间。";
    } else if (thread.status === "waiting_quota") {
      body = "已确认额度中断，额度恢复后会自动继续。";
    } else if (thread.status === "resuming") {
      body = "额度已恢复，正在同一个 Codex 任务中继续。";
    } else if (thread.status === "needs_attention") {
      body = "某个任务已安全暂停，请打开守护查看状态。";
    } else if (thread.status === "completed") {
      body = "某个目标已完成，请在 Codex 查看结果。";
    }
    if (body !== null) {
      const notification = new Notification({ title, body });
      notification.on("click", showWindow);
      notification.show();
    }
  }
}

function updateTray(current: AppSnapshotV2): void {
  if (tray === null) {
    return;
  }
  const limits = current.state.quota?.rateLimitsByLimitId;
  const windows = limits !== undefined && Object.keys(limits).length > 0
    ? Object.values(limits).flatMap((limit) =>
        [limit.primary, limit.secondary].filter(
          (window): window is QuotaWindow => window !== null,
        ),
      )
    : [
        current.state.quota?.primary,
        current.state.quota?.secondary,
      ].filter((window): window is QuotaWindow => window !== null && window !== undefined);
  windows.sort((left, right) => left.remainingPercent - right.remainingPercent);
  const visibleWindow =
    windows.find((window) => classifyQuotaWindowDuration(window.windowDurationMins) === "five_hour") ??
    windows.find((window) => classifyQuotaWindowDuration(window.windowDurationMins) === "weekly") ??
    windows[0];
  const visibleWindowKind = visibleWindow === undefined
    ? null
    : classifyQuotaWindowDuration(visibleWindow.windowDurationMins);
  const windowKindLabel = visibleWindowKind === "five_hour"
    ? "5 小时"
    : visibleWindowKind === "weekly"
      ? "周额度"
      : "额度";
  const visibleWindowLabel = visibleWindow?.limitName
    ? `${visibleWindow.limitName} · ${windowKindLabel}`
    : windowKindLabel;
  const quotaLabel = visibleWindow === undefined
    ? "额度读取中"
    : `${visibleWindowLabel}剩余 ${Math.round(visibleWindow.remainingPercent)}%`;
  const waiting = current.state.watchedThreads.filter(
    (thread) => thread.status === "waiting_quota" || thread.status === "waiting_quota_data",
  ).length;
  const attention = current.state.watchedThreads.filter(
    (thread) => thread.status === "needs_attention",
  ).length;
  const suffix = attention > 0
    ? ` · ${attention} 个需要处理`
    : waiting > 0
      ? ` · ${waiting} 个等待额度`
      : "";
  tray.setToolTip(`Codex 自动续跑守护 · ${quotaLabel}${suffix}`);
}

function showWindow(): void {
  if (mainWindow === null) {
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow(): void {
  if (mainWindow?.isVisible()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

function createWindow(showOnReady: boolean): BrowserWindow {
  const window = new BrowserWindow({
    width: 980,
    height: 800,
    minWidth: 760,
    minHeight: 640,
    show: false,
    title: "Codex 自动续跑守护",
    backgroundColor: "#eef1f5",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  void window.loadFile(path.join(__dirname, "index.html"));
  if (showOnReady) {
    window.once("ready-to-show", () => window.show());
  }
  window.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
    }
  });
  return window;
}

function createTray(): Tray {
  const icon = nativeImage.createFromPath(path.join(__dirname, "resources", "trayTemplate.svg"));
  icon.setTemplateImage(true);
  const nextTray = new Tray(icon);
  nextTray.on("click", toggleWindow);
  nextTray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "查看守护状态", click: showWindow },
      {
        label: "立即检查",
        click: () => void refreshAll().catch(() => undefined),
      },
      { type: "separator" },
      {
        label: "停止后台守护并退出",
        click: () => void requestQuit(),
      },
    ]),
  );
  return nextTray;
}

function requireThreadId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new TypeError("无效的 Codex 任务 ID");
  }
  return value.trim();
}

function requireGuardian(): ThreadGuardian {
  if (guardian === null) {
    throw new Error("守护服务尚未启动");
  }
  return guardian;
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  const expectedUrl = pathToFileURL(path.join(__dirname, "index.html")).href;
  if (
    mainWindow === null ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame?.url !== expectedUrl
  ) {
    throw new Error("拒绝来自非应用页面的操作");
  }
}

function serializeGuardianMutation<T>(operation: () => Promise<T>): Promise<T> {
  const pending = guardianMutationTail
    .catch(() => undefined)
    .then(operation);
  guardianMutationTail = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

function registerIpc(): void {
  ipcMain.handle("state:get", (event) => {
    assertTrustedRenderer(event);
    return snapshot();
  });
  ipcMain.handle("state:refresh", (event) => {
    assertTrustedRenderer(event);
    return refreshAll();
  });
  ipcMain.handle(
    "thread:set-enabled",
    async (event, threadId: unknown, enabled: unknown) => {
      assertTrustedRenderer(event);
      const current = requireGuardian();
      const safeThreadId = requireThreadId(threadId);
      if (typeof enabled !== "boolean") {
        throw new TypeError("无效的守护开关");
      }
      await serializeGuardianMutation(async () => {
        if (enabled) {
          await current.enableThread(safeThreadId);
        } else {
          await current.disableThread(safeThreadId);
        }
      });
    },
  );
  ipcMain.handle("thread:remove", async (event, threadId: unknown) => {
    assertTrustedRenderer(event);
    const current = requireGuardian();
    const safeThreadId = requireThreadId(threadId);
    await serializeGuardianMutation(() => current.removeThread(safeThreadId));
  });
  ipcMain.handle("privacy:clear-data", async (event) => {
    assertTrustedRenderer(event);
    await clearAllLocalData();
  });
  ipcMain.handle("app:quit", (event) => {
    assertTrustedRenderer(event);
    return requestQuit();
  });
}

async function requestQuit(): Promise<boolean> {
  const activeCount = guardian?.getState().watchedThreads.filter(
    (thread) => thread.enabled || thread.status === "resuming" || thread.status === "waiting_quota",
  ).length ?? 0;
  if (activeCount > 0) {
    const options: MessageBoxOptions = {
      type: "warning",
      title: "停止后台守护？",
      message: `仍有 ${activeCount} 个 Codex 任务依赖后台守护。`,
      detail: "退出后，额度到点不会自动继续；重新打开应用后才会恢复检查。",
      buttons: ["继续守护", "停止并退出"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const result = mainWindow === null
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(mainWindow, options);
    if (result.response !== 1) {
      return false;
    }
  }
  isQuitting = true;
  app.quit();
  return true;
}

interface CommandStatusReport {
  kind: "watched" | "not_watched";
  enabled: boolean;
  status: string | null;
  reply: string;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  const expectedUid = process.getuid?.();
  if (
    details.isSymbolicLink() ||
    !details.isDirectory() ||
    (expectedUid !== undefined && details.uid !== expectedUid)
  ) {
    throw new Error("本机数据目录不安全");
  }
  await chmod(directory, 0o700);
}

async function writePrivateJsonAtomic(
  destination: string,
  value: unknown,
): Promise<void> {
  const directory = path.dirname(destination);
  await ensurePrivateDirectory(directory);
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, destination);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function cleanupExpiredJsonFiles(
  directory: string,
  retentionMs: number,
  now = Date.now(),
): Promise<void> {
  let directoryDetails: Awaited<ReturnType<typeof lstat>>;
  try {
    directoryDetails = await lstat(directory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  const expectedUid = process.getuid?.();
  if (
    directoryDetails.isSymbolicLink() ||
    !directoryDetails.isDirectory() ||
    (expectedUid !== undefined && directoryDetails.uid !== expectedUid)
  ) {
    throw new Error("本机数据清理目录不安全");
  }
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      return;
    }
    const candidate = path.join(directory, entry.name);
    const details = await lstat(candidate);
    if (details.isFile() && now - details.mtimeMs > retentionMs) {
      await unlink(candidate).catch((error: unknown) => {
        if (!isNodeError(error, "ENOENT")) {
          throw error;
        }
      });
    }
  }));
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function cleanupLocalArtifacts(): Promise<void> {
  const userData = app.getPath("userData");
  await cleanupExpiredJsonFiles(
    path.join(userData, "acknowledgements"),
    ACKNOWLEDGEMENT_RETENTION_MS,
  );
  await cleanupExpiredJsonFiles(
    path.join(userData, "commands", ".dead-letter"),
    DEAD_LETTER_RETENTION_MS,
  );
}

function commandStatusReport(threadId: string): CommandStatusReport {
  const watched = requireGuardian().getThreadStatus(threadId);
  if (watched === null) {
    return {
      kind: "not_watched",
      enabled: false,
      status: null,
      reply: "当前任务未开启自动续跑。",
    };
  }
  const reply = watched.status === "completed"
    ? "当前目标已经完成并停止守护；如在同一任务中开始新目标，请重新开启。"
    : watched.status === "waiting_quota_data"
      ? "当前任务已开启自动续跑；已确认额度中断，正在等待准确刷新时间。"
      : watched.status === "waiting_quota"
        ? "当前任务已开启自动续跑，正在等待额度刷新。"
        : watched.status === "resuming"
          ? "当前任务已开启自动续跑，正在同一个 Codex 任务中继续。"
          : watched.status === "needs_attention"
            ? "自动续跑已安全暂停，需要回到 Codex 人工检查。"
            : watched.enabled
              ? "当前任务已开启自动续跑，后台已确认并正在守护。"
              : "当前任务自动续跑已关闭。";
  return {
    kind: "watched",
    enabled: watched.enabled,
    status: watched.status,
    reply,
  };
}

async function writeCommandAcknowledgement(
  command: GuardianCommand,
  success: boolean,
  message: string,
  statusReport?: CommandStatusReport,
): Promise<void> {
  if (!/^[0-9A-Za-z-]{1,128}$/u.test(command.id)) {
    throw new Error("无效的命令确认 ID");
  }
  const directory = path.join(app.getPath("userData"), "acknowledgements");
  const destination = path.join(directory, `${command.id}.json`);
  const acknowledgement = {
    version: 1,
    commandId: command.id,
    action: command.action,
    threadId: command.threadId,
    success,
    message,
    acknowledgedAt: Date.now(),
    ...(statusReport === undefined ? {} : { statusReport }),
  };
  await writePrivateJsonAtomic(destination, acknowledgement);
}

async function handleCommand(command: GuardianCommand): Promise<void> {
  let report: CommandStatusReport;
  try {
    report = await serializeGuardianMutation(async () => {
      const current = requireGuardian();
      if (command.action === "enable") {
        const existing = current.getThreadStatus(command.threadId);
        if (existing === null) {
          await current.registerThread(command.threadId, command.turnId);
        } else {
          await current.enableThread(command.threadId, command.turnId);
        }
      } else if (command.action === "disable") {
        if (current.getThreadStatus(command.threadId) !== null) {
          await current.disableThread(command.threadId);
        }
      } else {
        await current.noteControlTurn(command.threadId, command.turnId);
        await current.refreshQuota();
        await current.checkNow();
        runtime.lastQuotaCheckAt = new Date().toISOString();
        runtime.lastGuardianCheckAt = new Date().toISOString();
      }
      return commandStatusReport(command.threadId);
    });
  } catch (error) {
    await writeCommandAcknowledgement(
      command,
      false,
      "后台暂时无法完成设置；为避免重复执行，本次操作未生效。",
    );
    runtime.status = "error";
    runtime.lastError = "Codex 控制命令暂未生效，守护会继续安全重试。";
    broadcast();
    return;
  }

  // A successful state change and its acknowledgement are one logical
  // operation. If writing the ACK fails, let the inbox retry the declarative,
  // idempotent command instead of telling Codex that a successful change did
  // not happen.
  await writeCommandAcknowledgement(
    command,
    true,
    command.action === "enable"
      ? "后台已确认开启自动续跑。"
      : command.action === "disable"
        ? "后台已确认关闭自动续跑。"
        : report.reply,
    report,
  );
  runtime.status = "ready";
  runtime.appServerConnected = true;
  runtime.lastError = null;
  broadcast();
}

function reportCommandError(fileName: string, reason: string): void {
  void fileName;
  void reason;
  runtime.status = "error";
  runtime.lastError = "发现一条无效或过期的本机控制命令，已安全忽略。";
  broadcast();
}

function reportOperationalError(error: Error): void {
  void error;
  runtime.status = "error";
  runtime.lastError = "后台检查暂时失败；不会重复执行，并会继续重试。";
  broadcast();
}

function probeCodexVersion(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(
      codexPath,
      ["--version"],
      { timeout: 5_000, env: codexChildEnvironment(process.env) },
      (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      const version = stdout.trim();
      resolve(version.length > 0 ? version : null);
      },
    );
  });
}

async function readCodexVersion(): Promise<string | null> {
  try {
    return await probeCodexVersion();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function refreshHookReadiness(): Promise<void> {
  const server = appServer;
  if (server === null) {
    runtime.hookStatus = "error";
    runtime.hookMessage = "守护服务尚未连接 Codex。";
    return;
  }
  runtime.hookStatus = "checking";
  const cwds = [
    homedir(),
    ...(guardian?.getState().watchedThreads.map((thread) => thread.cwd) ?? []),
  ].filter((cwd, index, values) => values.indexOf(cwd) === index);
  try {
    const result = await server.listHooks(cwds);
    const entries = Array.isArray(result.data) ? result.data : [];
    const hooks = entries.flatMap((entry) =>
      isRecord(entry) && Array.isArray(entry.hooks) ? entry.hooks : [],
    ).filter(isRecord).filter((hook) => {
      const pluginId = typeof hook.pluginId === "string" ? hook.pluginId : "";
      const sourcePath = typeof hook.sourcePath === "string" ? hook.sourcePath : "";
      return pluginId.includes(AUTO_RESUME_PLUGIN_ID) || sourcePath.includes(AUTO_RESUME_PLUGIN_ID);
    });
    if (hooks.length === 0) {
      runtime.hookStatus = "missing";
      runtime.hookMessage = "尚未发现“自动续跑”插件；Codex 中的开启口令还不会生效。";
      return;
    }
    const enabled = hooks.filter((hook) => hook.enabled === true);
    const statuses = enabled.map((hook) => hook.trustStatus);
    if (enabled.length === 0) {
      runtime.hookStatus = "untrusted";
      runtime.hookMessage = "“自动续跑” Hook 尚未启用。";
    } else if (statuses.some((status) => status === "modified")) {
      runtime.hookStatus = "modified";
      runtime.hookMessage = "Hook 内容已变化，需要在 Codex 的 /hooks 中重新检查并信任。";
    } else if (statuses.every((status) => status === "trusted" || status === "managed")) {
      runtime.hookStatus = "trusted";
      runtime.hookMessage = "Hook 已安装并信任，可以在 Codex 中开启自动续跑。";
    } else {
      runtime.hookStatus = "untrusted";
      runtime.hookMessage = "请在 Codex 的 /hooks 面板中选择“自动续跑”并完成信任。";
    }
  } catch (error) {
    runtime.hookStatus = "error";
    void error;
    runtime.hookMessage = "暂时无法确认 Hook 状态；不会在未确认信任时自动续跑。";
  }
}

async function refreshVisibleQuota(): Promise<AppSnapshotV2> {
  if (quotaRefreshPromise !== null) {
    return quotaRefreshPromise;
  }
  const pending = (async () => {
    try {
      await requireGuardian().refreshQuota();
      runtime.lastQuotaCheckAt = new Date().toISOString();
      runtime.status = "ready";
      runtime.appServerConnected = true;
      runtime.lastError = null;
      return broadcast();
    } catch (error) {
      // Preserve the last successful snapshot and every guardian checkpoint.
      // A display refresh must never itself enable, disable, or resume a task.
      runtime.status = "error";
      void error;
      runtime.lastError = "额度刷新暂时失败，已保留上次安全结果并会继续重试。";
      broadcast();
      throw error;
    }
  })().finally(() => {
    if (quotaRefreshPromise === pending) {
      quotaRefreshPromise = null;
    }
  });
  quotaRefreshPromise = pending;
  return pending;
}

async function refreshAll(): Promise<AppSnapshotV2> {
  if (refreshPromise !== null) {
    return refreshPromise;
  }
  const pending = (async () => {
    const current = requireGuardian();
    try {
      const version = await readCodexVersion();
      runtime.codexVersion = version;
      await refreshHookReadiness();
      await refreshVisibleQuota();
      await current.checkNow();
      runtime.lastGuardianCheckAt = new Date().toISOString();
      runtime.status = "ready";
      runtime.appServerConnected = true;
      runtime.lastError = null;
      return broadcast();
    } catch (error) {
      runtime.status = "error";
      runtime.appServerConnected = false;
      void error;
      runtime.lastError = "暂时无法连接本机 Codex；不会启动新的自动续跑。";
      broadcast();
      throw error;
    }
  })().finally(() => {
    if (refreshPromise === pending) {
      refreshPromise = null;
    }
  });
  refreshPromise = pending;
  return pending;
}

async function startCommandInbox(): Promise<void> {
  const next = new CommandInbox({
    directory: path.join(app.getPath("userData"), "commands"),
    pollIntervalMs: 1_000,
    onInvalid: reportCommandError,
    onFailure: (failure) => {
      reportOperationalError(new Error(failure.reason));
    },
  });
  commandInbox = next;
  await next.start(handleCommand);
}

async function clearAllLocalData(): Promise<void> {
  const previousInbox = commandInbox;
  previousInbox?.stop();
  await previousInbox?.drain();
  commandInbox = null;
  try {
    await serializeGuardianMutation(async () => {
      await requireGuardian().clearAllLocalData();
      const userData = app.getPath("userData");
      await Promise.all([
        rm(path.join(userData, "commands"), { recursive: true, force: true }),
        rm(path.join(userData, "acknowledgements"), { recursive: true, force: true }),
      ]);
    });
  } finally {
    await startCommandInbox();
  }
  await writeAppLocation();
  broadcast();
}

async function writeAppLocation(): Promise<void> {
  if (!app.isPackaged) {
    return;
  }
  const appPath = path.resolve(path.dirname(app.getPath("exe")), "../..");
  const destination = path.join(app.getPath("userData"), "app-location.json");
  await writePrivateJsonAtomic(destination, { appPath, updatedAt: Date.now() });
}

async function bootstrap(): Promise<void> {
  if (process.platform === "darwin") {
    app.dock?.hide();
  }
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  appServer = new CodexAppServerClient({ codexPath });
  guardian = new ThreadGuardian({
    appServer,
    statePath: path.join(app.getPath("userData"), "state.json"),
    getCodexVersion: probeCodexVersion,
    onOperationalError: reportOperationalError,
  });
  registerIpc();
  guardian.onChanged(handleGuardianState);

  mainWindow = createWindow(!isBackgroundLaunch());
  tray = createTray();
  broadcast();

  let initialized = false;
  try {
    await guardian.initialize();
    initialized = true;
    runtime.codexVersion = await readCodexVersion();
    runtime.status = "ready";
    runtime.appServerConnected = true;
    runtime.lastError = null;
    await refreshHookReadiness();
  } catch (error) {
    runtime.status = "error";
    runtime.appServerConnected = false;
    void error;
    runtime.lastError = "守护服务尚未就绪；不会在状态不明时自动续跑。";
  }
  handleGuardianState(guardian.getState());

  await startCommandInbox();
  await cleanupLocalArtifacts();

  powerMonitor.on("resume", () => void refreshAll().catch(() => undefined));
  powerMonitor.on("unlock-screen", () => void refreshAll().catch(() => undefined));

  quotaRefreshTimer = setInterval(() => {
    // Keep the allowance current even when no guarded task is waiting.
    // This never calls checkNow: only the guardian's safety path may decide to
    // start a turn, using its own fresh quota read at the actual wake time.
    void refreshVisibleQuota().catch(() => undefined);
  }, QUOTA_REFRESH_INTERVAL_MS);
  quotaRefreshTimer.unref();

  artifactCleanupTimer = setInterval(() => {
    void cleanupLocalArtifacts().catch(reportOperationalError);
  }, ARTIFACT_CLEANUP_INTERVAL_MS);
  artifactCleanupTimer.unref();

  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
      args: ["--process-command-inbox"],
    });
    runtime.loginItemEnabled = app.getLoginItemSettings().openAtLogin;
  } else {
    runtime.loginItemEnabled = null;
  }
  runtime.notificationsSupported = Notification.isSupported();
  await writeAppLocation();
  if (initialized) {
    await refreshAll().catch(() => undefined);
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (!isBackgroundLaunch(argv)) {
      showWindow();
    }
    void commandInbox?.drain();
  });
  app.whenReady().then(bootstrap).catch((error: unknown) => {
    void error;
    dialog.showErrorBox(
      "Codex 自动续跑守护无法启动",
      "本机守护初始化失败。为避免暴露任务或路径详情，请从应用内的安全状态提示开始排查。",
    );
  });
}

app.on("before-quit", (event) => {
  if (shutdownComplete || guardian === null) {
    return;
  }
  event.preventDefault();
  isQuitting = true;
  if (quotaRefreshTimer !== null) {
    clearInterval(quotaRefreshTimer);
    quotaRefreshTimer = null;
  }
  if (artifactCleanupTimer !== null) {
    clearInterval(artifactCleanupTimer);
    artifactCleanupTimer = null;
  }
  commandInbox?.stop();
  if (shutdownPromise === null) {
    shutdownPromise = (async () => {
      try {
        await guardian?.shutdown();
      } finally {
        await appServer?.close();
      }
    })()
      .catch((error: unknown) => {
        void error;
        runtime.lastError = "退出时未能完整关闭本机守护服务。";
      })
      .finally(() => {
        shutdownComplete = true;
        app.quit();
      });
  }
});

app.on("window-all-closed", () => {
  // Menu-bar app: closing the window keeps the guardian alive.
});
