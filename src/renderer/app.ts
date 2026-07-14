import type {
  AppSnapshotV2,
  AttentionCode,
  GuardianEventType,
  TaskOutput,
  WatchedThread,
} from "../shared/types.js";
import { classifyQuotaWindowDuration } from "../core/quota.js";

type ThreadStatus =
  | "watching"
  | "waiting_quota_data"
  | "waiting_quota"
  | "resuming"
  | "completed"
  | "needs_attention"
  | "disabled";

type HookStatus =
  | "checking"
  | "trusted"
  | "untrusted"
  | "modified"
  | "missing"
  | "error";

type UnknownRecord = Record<string, unknown>;

interface QuotaWindowView {
  name: "primary" | "secondary" | null;
  limitId: string | null;
  limitName: string | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface QuotaView {
  primary: QuotaWindowView | null;
  secondary: QuotaWindowView | null;
  allWindows: QuotaWindowView[];
  capturedAt: number | null;
}

interface QuotaSlotView {
  label: string;
  window: QuotaWindowView | null;
}

interface ThreadView {
  source: WatchedThread;
  threadId: string;
  cwd: string;
  title: string | null;
  enabled: boolean;
  status: ThreadStatus;
  resumeAfter: number | null;
  resumePhase: "prepared" | "started" | "confirmed" | null;
  attentionReason: string | null;
  attentionCode: AttentionCode | null;
  goalObjective: string | null;
  lastResult: TaskOutput | null;
  registeredAt: number | null;
  updatedAt: number | null;
}

interface ActivityView {
  id: string;
  type: GuardianEventType;
  threadId: string;
  message: string;
  at: number;
}

const STATUS_LABELS: Record<ThreadStatus, string> = {
  watching: "守护中",
  waiting_quota_data: "确认刷新时间",
  waiting_quota: "等待额度",
  resuming: "正在续跑",
  completed: "目标已完成",
  needs_attention: "需要处理",
  disabled: "已关闭",
};

const STATUS_ORDER: Record<ThreadStatus, number> = {
  resuming: 0,
  waiting_quota_data: 1,
  waiting_quota: 2,
  needs_attention: 3,
  watching: 4,
  completed: 5,
  disabled: 6,
};

const HOOK_LABELS: Record<HookStatus, string> = {
  checking: "正在检查 Hook",
  trusted: "Hook 已信任，可以开启",
  untrusted: "需要在 /hooks 中信任",
  modified: "插件已更新，需要重新信任",
  missing: "自动续跑插件未安装",
  error: "暂时无法确认 Hook",
};

const ACTIVITY_LABELS: Record<GuardianEventType, string> = {
  guarding_enabled: "已开启",
  guarding_disabled: "已停止",
  quota_detected: "额度中断",
  quota_data_pending: "等待数据",
  resume_scheduled: "已排期",
  resume_started: "已续跑",
  resume_completed: "续跑结束",
  goal_completed: "目标完成",
  external_activity: "外部操作",
  needs_attention: "需要处理",
};

const runtimeStatus = getById<HTMLParagraphElement>("runtime-status");
const systemNotice = getById<HTMLDivElement>("system-notice");
const systemNoticeTitle = getById<HTMLElement>("system-notice-title");
const systemNoticeText = getById<HTMLParagraphElement>("system-notice-text");
const guardedCount = getById<HTMLElement>("guarded-count");
const waitingCount = getById<HTMLElement>("waiting-count");
const quotaEmpty = getById<HTMLDivElement>("quota-empty");
const quotaEmptyText = getById<HTMLSpanElement>("quota-empty-text");
const quotaTracks = getById<HTMLDivElement>("quota-tracks");
const quotaUpdated = getById<HTMLParagraphElement>("quota-updated");
const threadList = getById<HTMLDivElement>("thread-list");
const threadsEmpty = getById<HTMLDivElement>("threads-empty");
const threadsSummary = getById<HTMLParagraphElement>("threads-summary");
const threadTemplate = getTemplate("thread-card-template");
const refreshButton = getById<HTMLButtonElement>("refresh-button");
const quitButton = getById<HTMLButtonElement>("quit-button");
const copyCommandButton = getById<HTMLButtonElement>("copy-command-button");
const clearDataButton = getById<HTMLButtonElement>("clear-data-button");
const activationCommand = getById<HTMLElement>("activation-command");
const activationGuidance = getById<HTMLParagraphElement>("activation-guidance");
const hookReadiness = getById<HTMLParagraphElement>("hook-readiness");
const quotaExtra = getById<HTMLDivElement>("quota-extra");
const activityList = getById<HTMLOListElement>("activity-list");
const activityEmpty = getById<HTMLParagraphElement>("activity-empty");
const codexVersion = getById<HTMLParagraphElement>("codex-version");
const toastRegion = getById<HTMLDivElement>("toast-region");

let currentSnapshot: AppSnapshotV2 | null = null;
let stopListening: (() => void) | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
const pendingActions = new Set<string>();

function getById<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing renderer element: #${id}`);
  }
  return element as T;
}

function getTemplate(id: string): HTMLTemplateElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLTemplateElement)) {
    throw new Error(`Missing renderer template: #${id}`);
  }
  return element;
}

function find<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector(selector);
  if (!element) {
    throw new Error(`Missing renderer element: ${selector}`);
  }
  return element as T;
}

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTimestamp(value: unknown): number | null {
  const timestamp = finiteNumber(value);
  if (timestamp === null || timestamp <= 0) {
    return null;
  }
  return timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "时间待确认";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatRelativeTime(timestamp: number | null, now = Date.now()): string {
  if (timestamp === null) {
    return "刚刚登记";
  }
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) {
    return "刚刚更新";
  }
  if (elapsed < 3_600_000) {
    return `${Math.floor(elapsed / 60_000)} 分钟前更新`;
  }
  if (elapsed < 86_400_000) {
    return `${Math.floor(elapsed / 3_600_000)} 小时前更新`;
  }
  return `${formatDateTime(timestamp)} 更新`;
}

function formatCountdown(timestamp: number, now = Date.now()): string {
  const difference = timestamp - now;
  if (difference <= 0) {
    return "正在确认额度是否恢复";
  }

  const totalSeconds = Math.ceil(difference / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const clock = [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  return days > 0 ? `距离额度重置 ${days} 天 ${clock}` : `距离额度重置 ${clock}`;
}

function formatWindowDuration(minutes: number | null): string {
  if (minutes === null || minutes <= 0) {
    return "滚动窗口";
  }
  if (minutes % 10_080 === 0) {
    return `${minutes / 10_080} 周滚动窗口`;
  }
  if (minutes % 1_440 === 0) {
    return `${minutes / 1_440} 天滚动窗口`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60} 小时滚动窗口`;
  }
  return `${minutes} 分钟滚动窗口`;
}

function quotaSlots(quota: QuotaView): [QuotaSlotView, QuotaSlotView] {
  const windows = (quota.allWindows.length > 0
    ? quota.allWindows
    : [quota.primary, quota.secondary]
  ).filter(
    (window): window is QuotaWindowView => window !== null,
  );
  const fiveHour = windows.find(
    (window) => classifyQuotaWindowDuration(window.windowDurationMins) === "five_hour",
  ) ?? null;
  const weekly = windows.find(
    (window) => classifyQuotaWindowDuration(window.windowDurationMins) === "weekly",
  ) ?? null;
  const others = windows.filter((window) => window !== fiveHour && window !== weekly);

  const first = fiveHour ?? (weekly === null ? (others.shift() ?? null) : null);
  const second = weekly ?? (others.shift() ?? null);
  const firstLabel = first !== null && classifyQuotaWindowDuration(first.windowDurationMins) === "other"
    ? "其他额度"
    : "5 小时额度";
  const secondLabel = second !== null && classifyQuotaWindowDuration(second.windowDurationMins) === "other"
    ? "其他额度"
    : "周额度";
  return [
    { label: firstLabel, window: first },
    { label: secondLabel, window: second },
  ];
}

function messageFromError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "操作没有完成，请稍后重试。";
}

function showToast(message: string, kind: "info" | "error" = "info"): void {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.dataset.kind = kind;
  toast.textContent = message;
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 4_000);
}

function readQuotaWindow(value: unknown): QuotaWindowView | null {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = asRecord(value);
  const usedPercent = finiteNumber(raw.usedPercent);
  const remainingPercent = finiteNumber(raw.remainingPercent);
  if (usedPercent === null && remainingPercent === null) {
    return null;
  }
  return {
    name: raw.name === "primary" || raw.name === "secondary" ? raw.name : null,
    limitId: nonEmptyString(raw.limitId),
    limitName: nonEmptyString(raw.limitName),
    usedPercent,
    remainingPercent,
    windowDurationMins: finiteNumber(raw.windowDurationMins),
    resetsAt: normalizeTimestamp(raw.resetsAt),
  };
}

function readQuota(snapshot: AppSnapshotV2): QuotaView | null {
  const snapshotRaw = asRecord(snapshot);
  const stateRaw = asRecord(snapshotRaw.state);
  const quotaRaw = asRecord(stateRaw.quota ?? snapshotRaw.quota);
  if (Object.keys(quotaRaw).length === 0) {
    return null;
  }
  const primary = readQuotaWindow(quotaRaw.primary);
  const secondary = readQuotaWindow(quotaRaw.secondary);
  const allWindows: QuotaWindowView[] = [];
  const limits = asRecord(quotaRaw.rateLimitsByLimitId);
  for (const [limitId, candidate] of Object.entries(limits)) {
    const limit = asRecord(candidate);
    const limitName = nonEmptyString(limit.limitName);
    for (const name of ["primary", "secondary"] as const) {
      const window = readQuotaWindow(limit[name]);
      if (window) {
        allWindows.push({
          ...window,
          name,
          limitId: window.limitId ?? limitId,
          limitName: window.limitName ?? limitName,
        });
      }
    }
  }

  if (allWindows.length === 0) {
    if (primary) allWindows.push(primary);
    if (secondary) allWindows.push(secondary);
  }

  return {
    primary,
    secondary,
    allWindows,
    capturedAt: normalizeTimestamp(quotaRaw.capturedAt),
  };
}

function readWatchedThreads(snapshot: AppSnapshotV2): WatchedThread[] {
  const snapshotRaw = asRecord(snapshot);
  const stateRaw = asRecord(snapshotRaw.state);
  const candidate = stateRaw.watchedThreads ?? stateRaw.threads ?? snapshotRaw.watchedThreads;
  return Array.isArray(candidate) ? (candidate as WatchedThread[]) : [];
}

function isThreadStatus(value: unknown): value is ThreadStatus {
  return (
    value === "watching" ||
    value === "waiting_quota_data" ||
    value === "waiting_quota" ||
    value === "resuming" ||
    value === "completed" ||
    value === "needs_attention" ||
    value === "disabled"
  );
}

function isAttentionCode(value: unknown): value is AttentionCode {
  return (
    value === "needs_input" ||
    value === "blocked" ||
    value === "non_quota_error" ||
    value === "invalid_output" ||
    value === "external_activity" ||
    value === "version_changed" ||
    value === "project_missing" ||
    value === "interrupted" ||
    value === "runtime_unavailable"
  );
}

function readTaskOutput(value: unknown): TaskOutput | null {
  const raw = asRecord(value);
  if (
    (raw.status !== "complete" && raw.status !== "needs_input" && raw.status !== "blocked") ||
    typeof raw.message !== "string" ||
    (raw.verification !== null && typeof raw.verification !== "string")
  ) {
    return null;
  }
  return {
    status: raw.status,
    message: raw.message,
    verification: raw.verification,
  };
}

function readThread(thread: WatchedThread): ThreadView {
  const raw = asRecord(thread);
  const quotaWait = asRecord(raw.quotaWait);
  const resumeAttempt = asRecord(raw.resumeAttempt);
  const rawStatus = isThreadStatus(raw.status) ? raw.status : "watching";
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : rawStatus !== "disabled";
  const status = rawStatus === "needs_attention" || rawStatus === "completed"
    ? rawStatus
    : enabled
      ? rawStatus
      : "disabled";
  const phase = resumeAttempt.phase;

  return {
    source: thread,
    threadId: nonEmptyString(raw.threadId) ?? nonEmptyString(raw.id) ?? "",
    cwd: nonEmptyString(raw.cwd) ?? nonEmptyString(raw.projectPath) ?? "项目位置未知",
    title: nonEmptyString(raw.title),
    enabled,
    status,
    resumeAfter:
      normalizeTimestamp(quotaWait.resumeAfter) ??
      normalizeTimestamp(raw.resumeAfter) ??
      normalizeTimestamp(raw.nextResumeAt),
    resumePhase:
      phase === "prepared" || phase === "started" || phase === "confirmed" ? phase : null,
    attentionReason:
      nonEmptyString(raw.attentionReason) ??
      nonEmptyString(raw.lastError) ??
      nonEmptyString(raw.error),
    attentionCode: isAttentionCode(raw.attentionCode) ? raw.attentionCode : null,
    goalObjective: nonEmptyString(raw.goalObjective),
    lastResult: readTaskOutput(raw.lastResult),
    registeredAt: normalizeTimestamp(raw.registeredAt),
    updatedAt: normalizeTimestamp(raw.updatedAt),
  };
}

function shortThreadId(threadId: string): string {
  if (threadId.length <= 13) {
    return threadId;
  }
  return `${threadId.slice(0, 8)}…${threadId.slice(-4)}`;
}

function attentionMessage(code: AttentionCode | null): string {
  switch (code) {
    case "needs_input":
      return "Codex 需要你补充信息或做出选择，请回到原任务处理。";
    case "blocked":
      return "原任务遇到无法自动跨过的阻塞，请回到 Codex 检查。";
    case "external_activity":
      return "检测到你在 Codex 中手动继续过该任务，自动续跑已停止以避免重复执行。";
    case "version_changed":
      return "Codex 版本发生变化，需要确认兼容性后再重新开启守护。";
    case "project_missing":
      return "原项目文件夹当前不可用，请恢复后再重新开启守护。";
    case "invalid_output":
      return "Codex 没有返回可安全判断的结构化结果，请回到原任务检查。";
    case "non_quota_error":
    case "interrupted":
    case "runtime_unavailable":
    default:
      return "守护无法安全判断下一步，已暂停自动续跑；请回到原任务检查。";
  }
}

function renderRuntime(snapshot: AppSnapshotV2): void {
  const snapshotRaw = asRecord(snapshot);
  const runtime = asRecord(snapshotRaw.runtime);
  const status = runtime.status === "ready" || runtime.status === "error" ? runtime.status : "starting";
  const connected = runtime.appServerConnected !== false;
  const statusText = find<HTMLSpanElement>(runtimeStatus, "span:last-child");
  const lastError = nonEmptyString(runtime.lastError);
  const hookStatus: HookStatus =
    runtime.hookStatus === "trusted" ||
    runtime.hookStatus === "untrusted" ||
    runtime.hookStatus === "modified" ||
    runtime.hookStatus === "missing" ||
    runtime.hookStatus === "error"
      ? runtime.hookStatus
      : "checking";
  const hookMessage = nonEmptyString(runtime.hookMessage);
  const quotaRefreshFailed =
    status === "error" && connected && lastError?.startsWith("额度刷新暂时失败") === true;

  runtimeStatus.dataset.state = status === "ready" && hookStatus !== "trusted" ? "starting" : status;
  if (quotaRefreshFailed) {
    statusText.textContent = "额度更新重试中";
  } else if (status === "error") {
    statusText.textContent = "守护暂不可用";
  } else if (status === "starting") {
    statusText.textContent = "正在连接 Codex";
  } else if (!connected) {
    runtimeStatus.dataset.state = "starting";
    statusText.textContent = "正在重新连接";
  } else if (hookStatus === "trusted") {
    statusText.textContent = "可以自动续跑";
  } else if (hookStatus === "checking") {
    statusText.textContent = "正在检查 Hook";
  } else {
    statusText.textContent = "Hook 需要处理";
  }

  const version = nonEmptyString(runtime.codexVersion);
  codexVersion.textContent = version ? `Codex ${version}` : "Codex —";

  hookReadiness.dataset.state = hookStatus;
  hookReadiness.textContent = HOOK_LABELS[hookStatus];
  copyCommandButton.disabled = hookStatus !== "trusted";

  if (hookStatus === "trusted") {
    activationGuidance.textContent =
      "Hook 已安装并信任。回到当前 Codex 任务发送下面这句话，守护就会在额度恢复后接着完成原目标。";
  } else if (hookStatus === "untrusted" || hookStatus === "modified") {
    activationGuidance.textContent =
      "先在 Codex 输入 /hooks，找到“自动续跑”并信任；然后回到这里刷新。";
  } else if (hookStatus === "missing") {
    activationGuidance.textContent =
      "这台 Mac 还没有可用的自动续跑 Hook。完成插件安装后，再到 Codex 的 /hooks 中信任它。";
  } else if (hookStatus === "error") {
    activationGuidance.textContent =
      "暂时无法确认 Hook 状态。刷新前不会让你开启一个可能无法工作的守护。";
  } else {
    activationGuidance.textContent = "正在确认插件与 Hook 是否就绪…";
  }

  const runtimeUnavailable = status === "error" || !connected;
  const hookNeedsAction = hookStatus !== "trusted" && hookStatus !== "checking";
  systemNotice.hidden = !runtimeUnavailable && !lastError && !hookNeedsAction;
  if (runtimeUnavailable || lastError) {
    systemNoticeTitle.textContent = quotaRefreshFailed ? "额度暂未更新" : "守护服务暂不可用";
    systemNoticeText.textContent =
      lastError ?? "暂时无法连接本机 Codex，连接恢复前不会执行自动续跑。";
  } else if (hookNeedsAction) {
    systemNoticeTitle.textContent = hookStatus === "missing" ? "需要安装自动续跑插件" : "需要确认 Hook 信任";
    systemNoticeText.textContent =
      hookMessage ??
      (hookStatus === "untrusted" || hookStatus === "modified"
        ? "打开 Codex 的 /hooks 面板，信任自动续跑 Hook 后再刷新。"
        : "Hook 未准备好时，不会接受“开启自动续跑”指令。");
  }
}

function remainingPercent(window: QuotaWindowView): number {
  if (window.remainingPercent !== null) {
    return clamp(window.remainingPercent, 0, 100);
  }
  return clamp(100 - (window.usedPercent ?? 0), 0, 100);
}

function renderQuotaWindow(
  kind: "primary" | "secondary",
  label: string,
  window: QuotaWindowView | null,
): void {
  const article = find<HTMLElement>(quotaTracks, `[data-quota="${kind}"]`);
  const labelElement = find<HTMLElement>(article, '[data-field="label"]');
  const remainingElement = find<HTMLElement>(article, '[data-field="remaining"]');
  const resetElement = find<HTMLTimeElement>(article, '[data-field="reset-time"]');
  const durationElement = find<HTMLElement>(article, '[data-field="duration"]');
  const countdownElement = find<HTMLElement>(article, '[data-field="countdown"]');
  const progressElement = find<HTMLElement>(article, '[data-field="progress"]');
  labelElement.textContent = label;
  progressElement.setAttribute("aria-label", `${label}剩余`);

  if (!window) {
    article.dataset.resetAt = "";
    article.dataset.missing = "true";
    remainingElement.textContent = "—";
    resetElement.textContent = "尚未提供";
    resetElement.removeAttribute("datetime");
    durationElement.textContent = "额度窗口待确认";
    countdownElement.textContent = "Codex 当前未提供此窗口";
    progressElement.style.setProperty("--quota-value", "0");
    progressElement.dataset.low = "false";
    progressElement.setAttribute("aria-valuenow", "0");
    progressElement.setAttribute("aria-valuetext", "额度数据尚未提供");
    return;
  }

  delete article.dataset.missing;
  const remaining = remainingPercent(window);
  remainingElement.textContent = formatPercent(remaining);
  durationElement.textContent = formatWindowDuration(window.windowDurationMins);
  progressElement.style.setProperty("--quota-value", String(remaining));
  progressElement.dataset.low = String(remaining <= 20);
  progressElement.setAttribute("aria-valuenow", String(Math.round(remaining)));
  progressElement.setAttribute("aria-valuetext", `${formatPercent(remaining)}% 剩余`);

  if (window.resetsAt !== null) {
    article.dataset.resetAt = String(window.resetsAt);
    resetElement.textContent = formatDateTime(window.resetsAt);
    resetElement.dateTime = new Date(window.resetsAt).toISOString();
    countdownElement.textContent = formatCountdown(window.resetsAt);
  } else {
    article.dataset.resetAt = "";
    resetElement.textContent = "尚未提供";
    resetElement.removeAttribute("datetime");
    countdownElement.textContent = "刷新时间待确认";
  }
}

function quotaWindowKey(window: QuotaWindowView): string {
  return [
    window.limitId ?? "legacy",
    window.name ?? "window",
    window.windowDurationMins ?? "unknown",
    window.resetsAt ?? "unknown",
  ].join(":");
}

function renderExtraQuotaWindows(
  quota: QuotaView,
  selected: readonly (QuotaWindowView | null)[],
): void {
  const selectedKeys = new Set(
    selected.filter((window): window is QuotaWindowView => window !== null).map(quotaWindowKey),
  );
  const extras = quota.allWindows.filter((window) => !selectedKeys.has(quotaWindowKey(window)));
  if (extras.length === 0) {
    quotaExtra.hidden = true;
    quotaExtra.replaceChildren();
    return;
  }

  const heading = document.createElement("p");
  heading.className = "quota-extra-heading";
  heading.textContent = "其他额度桶";
  const rows = extras.map((window) => {
    const row = document.createElement("article");
    row.className = "quota-extra-row";
    if (window.resetsAt !== null) {
      row.dataset.resetAt = String(window.resetsAt);
    }

    const identity = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = window.limitName ?? window.limitId ?? "其他额度";
    const duration = document.createElement("span");
    duration.textContent = formatWindowDuration(window.windowDurationMins);
    identity.append(name, duration);

    const amount = document.createElement("p");
    amount.className = "quota-extra-amount";
    amount.textContent = `${formatPercent(remainingPercent(window))}% 剩余`;

    const timing = document.createElement("div");
    timing.className = "quota-extra-timing";
    const reset = document.createElement("time");
    if (window.resetsAt !== null) {
      reset.dateTime = new Date(window.resetsAt).toISOString();
      reset.textContent = formatDateTime(window.resetsAt);
    } else {
      reset.textContent = "刷新时间待确认";
    }
    const countdown = document.createElement("span");
    countdown.dataset.field = "countdown";
    countdown.textContent = window.resetsAt !== null
      ? formatCountdown(window.resetsAt)
      : "Codex 当前未提供刷新时间";
    timing.append(reset, countdown);
    row.append(identity, amount, timing);
    return row;
  });
  quotaExtra.replaceChildren(heading, ...rows);
  quotaExtra.hidden = false;
}

function renderQuota(snapshot: AppSnapshotV2, threads: readonly ThreadView[]): void {
  const quota = readQuota(snapshot);
  const activeThreads = threads.filter((thread) => thread.enabled).length;
  const waitingThreads = threads.filter(
    (thread) => thread.status === "waiting_quota" || thread.status === "waiting_quota_data",
  ).length;
  guardedCount.textContent = String(activeThreads);
  waitingCount.textContent = String(waitingThreads);

  if (!quota) {
    quotaEmpty.hidden = false;
    quotaTracks.hidden = true;
    quotaUpdated.textContent = "";
    quotaEmptyText.textContent = waitingThreads > 0
      ? "已确认任务因额度暂停；Codex 尚未提供准确刷新时间，守护会继续读取。"
      : runtimeStatus.dataset.state === "error"
        ? "暂时无法读取额度，正在等待 Codex 恢复连接。"
        : "正在读取 Codex 额度…";
    quotaExtra.hidden = true;
    quotaExtra.replaceChildren();
    return;
  }

  quotaEmpty.hidden = true;
  quotaTracks.hidden = false;
  const [firstSlot, secondSlot] = quotaSlots(quota);
  renderQuotaWindow("primary", firstSlot.label, firstSlot.window);
  renderQuotaWindow("secondary", secondSlot.label, secondSlot.window);
  renderExtraQuotaWindows(quota, [firstSlot.window, secondSlot.window]);
  quotaUpdated.textContent = quota.capturedAt
    ? `额度更新于 ${formatClock(quota.capturedAt)}`
    : "额度更新时间待确认";
}

function nextStep(thread: ThreadView): { title: string; detail: string } {
  if (thread.status === "waiting_quota_data") {
    return {
      title: "正在确认准确的额度刷新时间",
      detail: "不会猜测时间，也不会提前重复续跑；拿到官方刷新时间后才会开始倒计时。",
    };
  }

  if (thread.status === "waiting_quota") {
    if (thread.resumeAfter !== null) {
      return {
        title: `${formatDateTime(thread.resumeAfter)} 后检查并续跑`,
        detail: formatCountdown(thread.resumeAfter),
      };
    }
    return {
      title: "等待额度刷新后继续",
      detail: "拿到准确刷新时间后，这里会显示倒计时。",
    };
  }

  if (thread.status === "resuming") {
    const phaseDetails = {
      prepared: "已确认没有人工继续，正在准备恢复。",
      started: "续跑已经启动，正在等待 Codex 确认。",
      confirmed: "本次续跑已确认，继续观察任务状态。",
    } as const;
    return {
      title: "正在原 Codex 任务中继续",
      detail: thread.resumePhase ? phaseDetails[thread.resumePhase] : "恢复请求正在处理。",
    };
  }

  if (thread.status === "needs_attention") {
    return {
      title: "自动续跑已暂停",
      detail: "处理下面的原因后，可重新开启守护。",
    };
  }

  if (thread.status === "completed") {
    return {
      title: "Codex 已确认目标完成",
      detail: "本轮守护已结束；验证详情保留在原 Codex 任务中。",
    };
  }

  if (thread.status === "disabled") {
    return {
      title: "不会自动续跑",
      detail: "任务仍在 Codex 中，需要时可随时重新开启。",
    };
  }

  return {
    title: "继续观察这个 Codex 任务",
    detail: "只有顶层任务因额度中断时，才会安排自动续跑。",
  };
}

function toggleLabel(thread: ThreadView): string {
  if (thread.enabled) {
    return thread.status === "resuming" ? "本次结束后停止" : "关闭守护";
  }
  if (thread.status === "completed") {
    return "守护新目标";
  }
  if (thread.status === "needs_attention") {
    return thread.attentionCode === "project_missing" ||
      thread.attentionCode === "version_changed" ||
      thread.attentionCode === "runtime_unavailable"
      ? "问题解决后重试"
      : "确认后重新守护";
  }
  return "重新守护";
}

function confirmReenable(thread: ThreadView, title: string): boolean {
  if (thread.status === "completed") {
    return window.confirm(
      `要重新守护“${title}”吗？\n请先确认你已经在 Codex 中开始了一个新目标；否则无需重新开启。`,
    );
  }
  if (thread.status !== "needs_attention") {
    return true;
  }

  const detail = thread.attentionCode === "external_activity"
    ? "请确认 Codex 中的人工操作已经结束，并以当前最新进度作为新的守护起点。"
    : "请确认下方问题已经处理，并且现在可以安全地继续观察这个任务。";
  return window.confirm(`重新守护“${title}”？\n${detail}`);
}

function captureFocus(): { threadId: string; control: string } | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) {
    return null;
  }
  const card = active.closest<HTMLElement>(".thread-card");
  const threadId = card?.dataset.threadId;
  const control = active.dataset.control;
  return threadId && control ? { threadId, control } : null;
}

function restoreFocus(target: { threadId: string; control: string } | null): void {
  if (!target || !document.hasFocus()) {
    return;
  }
  const card = [...threadList.querySelectorAll<HTMLElement>(".thread-card")].find(
    (candidate) => candidate.dataset.threadId === target.threadId,
  );
  const control = card
    ? [...card.querySelectorAll<HTMLElement>("[data-control]")].find(
        (candidate) => candidate.dataset.control === target.control,
      )
    : null;
  if (control) {
    window.requestAnimationFrame(() => control.focus({ preventScroll: true }));
  }
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) {
      throw new Error("无法复制，请手动选择文字。");
    }
  }
}

function renderThread(thread: ThreadView): HTMLElement {
  const fragment = threadTemplate.content.cloneNode(true) as DocumentFragment;
  const card = find<HTMLElement>(fragment, ".thread-card");
  const statusElement = find<HTMLElement>(card, ".status-pill");
  const updatedElement = find<HTMLTimeElement>(card, ".thread-updated");
  const titleElement = find<HTMLHeadingElement>(card, ".thread-title");
  const pathElement = find<HTMLParagraphElement>(card, ".thread-path");
  const idElement = find<HTMLElement>(card, ".thread-id");
  const copyIdButton = find<HTMLButtonElement>(card, ".copy-thread-id");
  const toggleButton = find<HTMLButtonElement>(card, ".thread-toggle");
  const nextTitle = find<HTMLElement>(card, ".next-step-title");
  const nextDetail = find<HTMLParagraphElement>(card, ".next-step-detail");
  const errorPanel = find<HTMLElement>(card, ".thread-error");
  const errorMessage = find<HTMLParagraphElement>(card, ".thread-error-message");
  const removeButton = find<HTMLButtonElement>(card, ".remove-thread");

  card.dataset.threadId = thread.threadId;
  card.dataset.status = thread.status;
  card.dataset.enabled = String(thread.enabled);
  statusElement.textContent = STATUS_LABELS[thread.status];
  const effectiveUpdatedAt = thread.updatedAt ?? thread.registeredAt;
  updatedElement.textContent = formatRelativeTime(effectiveUpdatedAt);
  if (effectiveUpdatedAt !== null) {
    updatedElement.dateTime = new Date(effectiveUpdatedAt).toISOString();
  }
  const shortId = shortThreadId(thread.threadId);
  titleElement.textContent = shortId ? `Codex 任务 ${shortId}` : "Codex 任务";
  pathElement.textContent = "本机项目（路径已隐藏）";
  pathElement.removeAttribute("title");
  idElement.textContent = shortId || "尚未取得";
  idElement.removeAttribute("title");

  const step = nextStep(thread);
  nextTitle.textContent = step.title;
  nextDetail.textContent = step.detail;
  if (thread.resumeAfter !== null) {
    nextDetail.dataset.resumeAt = String(thread.resumeAfter);
  }

  const showError = thread.status === "needs_attention";
  errorPanel.hidden = !showError;
  errorMessage.textContent = attentionMessage(thread.attentionCode);

  const toggleKey = `toggle:${thread.threadId}`;
  toggleButton.textContent = toggleLabel(thread);
  toggleButton.setAttribute(
    "aria-label",
    `${toggleLabel(thread)}“${titleElement.textContent}”`,
  );
  toggleButton.dataset.control = "toggle";
  toggleButton.disabled = !thread.threadId || pendingActions.has(toggleKey);

  const removeKey = `remove:${thread.threadId}`;
  removeButton.dataset.control = "remove";
  removeButton.disabled = !thread.threadId || pendingActions.has(removeKey);
  copyIdButton.dataset.control = "copy-id";
  copyIdButton.disabled = !thread.threadId;

  toggleButton.addEventListener("click", async () => {
    if (!thread.enabled && !confirmReenable(thread, titleElement.textContent ?? "这个任务")) {
      return;
    }
    pendingActions.add(toggleKey);
    toggleButton.disabled = true;
    try {
      await window.resumeManager.setThreadEnabled(thread.threadId, !thread.enabled);
      showToast(
        thread.enabled
          ? thread.status === "resuming"
            ? "会在本次续跑结束后停止守护"
            : "已关闭这个任务的自动续跑"
          : "已重新开启守护",
      );
    } catch (error) {
      showToast(messageFromError(error), "error");
    } finally {
      pendingActions.delete(toggleKey);
      toggleButton.disabled = false;
    }
  });

  copyIdButton.addEventListener("click", async () => {
    try {
      await copyText(thread.threadId);
      showToast("任务 ID 已复制");
    } catch (error) {
      showToast(messageFromError(error), "error");
    }
  });

  removeButton.addEventListener("click", async () => {
    const confirmed = window.confirm(
      `移除“${titleElement.textContent}”并关闭守护？\nCodex 里的原任务不会被删除，但之后不会再自动续跑。`,
    );
    if (!confirmed) {
      return;
    }
    pendingActions.add(removeKey);
    removeButton.disabled = true;
    try {
      await window.resumeManager.removeThread(thread.threadId);
      showToast("已从守护列表移除");
    } catch (error) {
      showToast(messageFromError(error), "error");
    } finally {
      pendingActions.delete(removeKey);
      removeButton.disabled = false;
    }
  });

  return card;
}

function renderThreads(threads: readonly ThreadView[]): void {
  const focusTarget = captureFocus();
  const ordered = [...threads].sort((left, right) => {
    const statusDifference = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
    if (statusDifference !== 0) {
      return statusDifference;
    }
    return (right.updatedAt ?? right.registeredAt ?? 0) - (left.updatedAt ?? left.registeredAt ?? 0);
  });

  threadList.replaceChildren(...ordered.map(renderThread));
  threadsEmpty.hidden = ordered.length > 0;
  threadList.hidden = ordered.length === 0;

  const waiting = threads.filter(
    (thread) => thread.status === "waiting_quota" || thread.status === "waiting_quota_data",
  ).length;
  const attention = threads.filter((thread) => thread.status === "needs_attention").length;
  const summary = [`${threads.length} 个任务`];
  if (waiting) {
    summary.push(`${waiting} 个等额度`);
  }
  if (attention) {
    summary.push(`${attention} 个需处理`);
  }
  threadsSummary.textContent = summary.join(" · ");
  restoreFocus(focusTarget);
}

function isGuardianEventType(value: unknown): value is GuardianEventType {
  return (
    value === "guarding_enabled" ||
    value === "guarding_disabled" ||
    value === "quota_detected" ||
    value === "quota_data_pending" ||
    value === "resume_scheduled" ||
    value === "resume_started" ||
    value === "resume_completed" ||
    value === "goal_completed" ||
    value === "external_activity" ||
    value === "needs_attention"
  );
}

function readActivities(snapshot: AppSnapshotV2): ActivityView[] {
  const state = asRecord(asRecord(snapshot).state);
  if (!Array.isArray(state.events)) {
    return [];
  }
  const activities: ActivityView[] = [];
  for (const candidate of state.events) {
    const event = asRecord(candidate);
    const at = normalizeTimestamp(event.at);
    if (
      !isGuardianEventType(event.type) ||
      at === null ||
      typeof event.threadId !== "string" ||
      typeof event.message !== "string"
    ) {
      continue;
    }
    activities.push({
      id: nonEmptyString(event.id) ?? `${event.threadId}:${at}:${event.type}`,
      type: event.type,
      threadId: event.threadId,
      message: event.message,
      at,
    });
  }
  return activities.sort((left, right) => right.at - left.at).slice(0, 12);
}

function renderActivity(snapshot: AppSnapshotV2): void {
  const activities = readActivities(snapshot);
  const rows = activities.map((activity) => {
    const row = document.createElement("li");
    row.className = "activity-row";
    row.dataset.event = activity.type;
    row.dataset.eventId = activity.id;

    const marker = document.createElement("span");
    marker.className = "activity-marker";
    marker.setAttribute("aria-hidden", "true");

    const copy = document.createElement("div");
    copy.className = "activity-copy";
    const heading = document.createElement("div");
    heading.className = "activity-heading";
    const label = document.createElement("strong");
    label.textContent = ACTIVITY_LABELS[activity.type];
    const time = document.createElement("time");
    time.dateTime = new Date(activity.at).toISOString();
    time.textContent = formatRelativeTime(activity.at);
    heading.append(label, time);
    const message = document.createElement("p");
    message.textContent = activity.message;
    const thread = document.createElement("code");
    thread.textContent = activity.threadId
      ? `任务 ${activity.threadId.slice(0, 8)}…`
      : "Codex 任务";
    copy.append(heading, message, thread);
    row.append(marker, copy);
    return row;
  });
  activityList.replaceChildren(...rows);
  activityList.hidden = rows.length === 0;
  activityEmpty.hidden = rows.length > 0;
}

function render(snapshot: AppSnapshotV2): void {
  currentSnapshot = snapshot;
  const threads = readWatchedThreads(snapshot).map(readThread);
  renderRuntime(snapshot);
  renderQuota(snapshot, threads);
  renderThreads(threads);
  renderActivity(snapshot);
  updateCountdowns();
}

function updateCountdowns(): void {
  const now = Date.now();
  for (const article of quotaTracks.querySelectorAll<HTMLElement>("[data-reset-at]")) {
    const timestamp = Number(article.dataset.resetAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      continue;
    }
    const countdown = find<HTMLElement>(article, '[data-field="countdown"]');
    countdown.textContent = formatCountdown(timestamp, now);
  }

  for (const element of threadList.querySelectorAll<HTMLElement>("[data-resume-at]")) {
    const timestamp = Number(element.dataset.resumeAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      continue;
    }
    element.textContent = formatCountdown(timestamp, now);
  }
}

refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  refreshButton.setAttribute("aria-busy", "true");
  try {
    const refreshed = await window.resumeManager.refresh();
    if (typeof refreshed === "object" && refreshed !== null) {
      render(refreshed);
    }
    showToast("额度与任务状态已刷新");
  } catch (error) {
    showToast(messageFromError(error), "error");
  } finally {
    refreshButton.disabled = false;
    refreshButton.removeAttribute("aria-busy");
  }
});

copyCommandButton.addEventListener("click", async () => {
  try {
    await copyText(activationCommand.textContent?.trim() ?? "开启自动续跑");
    copyCommandButton.textContent = "已复制";
    showToast("回到 Codex 当前任务粘贴发送即可");
    window.setTimeout(() => {
      copyCommandButton.textContent = "复制";
    }, 2_000);
  } catch (error) {
    showToast(messageFromError(error), "error");
  }
});

clearDataButton.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "清除这台 Mac 上的全部守护数据？\n守护列表、运行记录、额度缓存和本机控制回执都会删除；Codex 中的原任务不会被删除。",
  );
  if (!confirmed) {
    return;
  }
  clearDataButton.disabled = true;
  try {
    await window.resumeManager.clearLocalData();
    showToast("本机守护数据已清除");
  } catch (error) {
    showToast(messageFromError(error), "error");
  } finally {
    clearDataButton.disabled = false;
  }
});

quitButton.addEventListener("click", async () => {
  quitButton.disabled = true;
  try {
    const didQuit = await window.resumeManager.quit();
    if (didQuit === false) {
      quitButton.disabled = false;
      showToast("已继续在后台守护");
    }
  } catch (error) {
    quitButton.disabled = false;
    showToast(messageFromError(error), "error");
  }
});

async function start(): Promise<void> {
  let receivedPush = false;
  stopListening = window.resumeManager.onStateChanged((snapshot) => {
    receivedPush = true;
    render(snapshot);
  });

  try {
    const initialSnapshot = await window.resumeManager.getState();
    if (!receivedPush) {
      render(initialSnapshot);
    }
  } catch (error) {
    runtimeStatus.dataset.state = "error";
    find<HTMLSpanElement>(runtimeStatus, "span:last-child").textContent = "无法读取本机状态";
    quotaEmptyText.textContent = "暂时无法读取额度。";
    systemNotice.hidden = false;
    systemNoticeText.textContent = messageFromError(error);
  }

  countdownTimer = setInterval(updateCountdowns, 1_000);
}

window.addEventListener("beforeunload", () => {
  stopListening?.();
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
  }
});

void start();
