export type AttentionCode =
  | "needs_input"
  | "blocked"
  | "non_quota_error"
  | "invalid_output"
  | "external_activity"
  | "version_changed"
  | "project_missing"
  | "interrupted"
  | "runtime_unavailable";

/** Prevent model-authored summaries from becoming an unbounded local payload. */
export const MAX_TASK_OUTPUT_TEXT_LENGTH = 2_000;

export interface TaskOutput {
  status: "complete" | "needs_input" | "blocked";
  message: string;
  verification: string | null;
}

export type QuotaWindowName = "primary" | "secondary";

export interface QuotaWindow {
  name: QuotaWindowName;
  /**
   * Stable metered bucket identity. Optional only while loading pre-V3 state;
   * newly parsed App Server snapshots always populate both identity fields.
   */
  limitId?: string;
  limitName?: string | null;
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  /** Unix epoch milliseconds. */
  resetsAt: number | null;
}

export interface QuotaLimit {
  limitId: string;
  limitName: string | null;
  primary: QuotaWindow | null;
  secondary: QuotaWindow | null;
  rateLimitReachedType: string | null;
}

export interface QuotaSnapshot {
  /** Backward-compatible single-bucket projection used by the existing UI. */
  primary: QuotaWindow | null;
  secondary: QuotaWindow | null;
  rateLimitReachedType: string | null;
  /**
   * Authoritative multi-bucket view, keyed by the App Server `limitId`.
   * Optional only so persisted pre-V3 state remains readable.
   */
  rateLimitsByLimitId?: Record<string, QuotaLimit>;
  /** Unix epoch milliseconds. */
  capturedAt: number;
}

export interface QuotaWait {
  failedTurnId: string;
  blockedWindows: QuotaWindow[];
  /**
   * Unix epoch milliseconds, including the one-minute safety margin. `null`
   * means Codex reported a block but has not supplied a reset timestamp yet.
   */
  resumeAfter: number | null;
  attemptCount: number;
  idempotencyKey: string;
}

/**
 * Recognition-only shape for state written by the retired manager-owned task
 * runner. The task array is intentionally opaque: legacy prompts and results
 * are discarded without validation, projection, or migration.
 */
export interface LegacyAppStateV1 {
  version: 1;
  tasks: unknown[];
  quota?: unknown;
  completedResumeKeys?: unknown;
  updatedAt?: unknown;
}

/** User-facing state for a Codex Desktop thread guarded in place. */
export type WatchedThreadStatus =
  | "watching"
  | "waiting_quota_data"
  | "waiting_quota"
  | "resuming"
  | "completed"
  | "needs_attention"
  | "disabled";

export type ThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export type GuardianEventType =
  | "guarding_enabled"
  | "guarding_disabled"
  | "quota_detected"
  | "quota_data_pending"
  | "resume_scheduled"
  | "resume_started"
  | "resume_completed"
  | "goal_completed"
  | "external_activity"
  | "needs_attention";

export interface GuardianEvent {
  id: string;
  type: GuardianEventType;
  threadId: string;
  turnId: string | null;
  message: string;
  /** Unix epoch milliseconds. */
  at: number;
}

const GUARDIAN_EVENT_MESSAGES: Readonly<Record<GuardianEventType, string>> = {
  guarding_enabled: "已开启自动续跑守护。",
  guarding_disabled: "已关闭自动续跑守护。",
  quota_detected: "已确认额度中断。",
  quota_data_pending: "正在等待准确的额度刷新时间。",
  resume_scheduled: "已安排额度恢复后的检查。",
  resume_started: "已启动一次自动续跑。",
  resume_completed: "自动续跑已结束。",
  goal_completed: "目标已完成。",
  external_activity: "检测到外部操作，自动续跑已暂停。",
  needs_attention: "自动续跑需要人工处理。",
};

/** A bounded, content-free message for persisted and user-facing event history. */
export function guardianEventMessage(type: GuardianEventType): string {
  return GUARDIAN_EVENT_MESSAGES[type];
}

/**
 * A persisted three-phase resume checkpoint.
 *
 * `prepared` is written before either App Server request, `started` after
 * `turn/start` returns a turn id, and `confirmed` after that turn reaches a
 * terminal state (or recovery observes that the failed turn has changed).
 */
export type ResumeAttemptPhase = "prepared" | "started" | "confirmed";

export interface ResumeAttempt {
  key: string;
  phase: ResumeAttemptPhase;
  failedTurnId: string;
  /** Unix epoch milliseconds. */
  preparedAt: number;
  /** Unix epoch milliseconds. */
  startedAt: number | null;
  startedTurnId: string | null;
  /** Unix epoch milliseconds. */
  confirmedAt: number | null;
}

export interface WatchedThread {
  threadId: string;
  cwd: string;
  title: string | null;
  /** Codex CLI version recorded when guarding was explicitly enabled. */
  codexVersion: string | null;
  enabled: boolean;
  status: WatchedThreadStatus;
  quotaWait: QuotaWait | null;
  resumeAttempt: ResumeAttempt | null;
  lastObservedTurnId: string | null;
  /** Read from Codex's persisted `/goal` state when one exists. */
  goalObjective?: string | null;
  goalStatus?: ThreadGoalStatus | null;
  /** Structured result from the most recent automatic continuation. */
  lastResult?: TaskOutput | null;
  /**
   * Recent UserPromptSubmit turn ids that were proven to be local guardian
   * controls. They may trail a quota failure without counting as manual work.
   */
  controlTurnIds?: string[];
  attentionCode?: AttentionCode | null;
  attentionReason: string | null;
  /** Unix epoch milliseconds. */
  lastSuccessfulCheckAt?: number | null;
  /** Unix epoch milliseconds. */
  registeredAt: number;
  /** Unix epoch milliseconds. */
  updatedAt: number;
}

/** V2 adds opt-in guarding for tasks that were created in Codex itself. */
export interface AppStateV2 {
  version: 2;
  watchedThreads: WatchedThread[];
  quota: QuotaSnapshot | null;
  completedResumeKeys: string[];
  /** Privacy-safe operational history; never stores prompts or hidden reasoning. */
  events?: GuardianEvent[];
  /** Unix epoch milliseconds. */
  updatedAt: number;
}

export interface RuntimeHealth {
  status: "starting" | "ready" | "error";
  codexPath: string;
  codexVersion: string | null;
  appServerConnected: boolean;
  activeTaskId: string | null;
  activePid: number | null;
  lastQuotaCheckAt: string | null;
  lastError: string | null;
  hookStatus?: "checking" | "trusted" | "untrusted" | "modified" | "missing" | "error";
  hookMessage?: string | null;
  loginItemEnabled?: boolean | null;
  notificationsSupported?: boolean;
  lastGuardianCheckAt?: string | null;
}

export interface AppSnapshotV2 {
  state: AppStateV2;
  runtime: RuntimeHealth;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isTaskOutput(value: unknown): value is TaskOutput {
  return (
    isRecord(value) &&
    (value.status === "complete" ||
      value.status === "needs_input" ||
      value.status === "blocked") &&
    typeof value.message === "string" &&
    isNullableString(value.verification)
  );
}

function isQuotaWindow(value: unknown): value is QuotaWindow {
  return (
    isRecord(value) &&
    (value.name === "primary" || value.name === "secondary") &&
    (!Object.hasOwn(value, "limitId") ||
      (typeof value.limitId === "string" && value.limitId.length > 0)) &&
    (!Object.hasOwn(value, "limitName") || isNullableString(value.limitName)) &&
    isFiniteNumber(value.usedPercent) &&
    isFiniteNumber(value.remainingPercent) &&
    (value.windowDurationMins === null || isFiniteNumber(value.windowDurationMins)) &&
    (value.resetsAt === null || isFiniteNumber(value.resetsAt))
  );
}

function isQuotaLimit(value: unknown, expectedLimitId: string): value is QuotaLimit {
  if (
    !isRecord(value) ||
    value.limitId !== expectedLimitId ||
    expectedLimitId.length === 0 ||
    !isNullableString(value.limitName) ||
    !(value.primary === null ||
      (isQuotaWindow(value.primary) &&
        value.primary.name === "primary" &&
        value.primary.limitId === expectedLimitId &&
        value.primary.limitName === value.limitName)) ||
    !(value.secondary === null ||
      (isQuotaWindow(value.secondary) &&
        value.secondary.name === "secondary" &&
        value.secondary.limitId === expectedLimitId &&
        value.secondary.limitName === value.limitName)) ||
    !isNullableString(value.rateLimitReachedType)
  ) {
    return false;
  }
  return true;
}

function isQuotaLimitsById(value: unknown): value is Record<string, QuotaLimit> {
  return (
    isRecord(value) &&
    Object.entries(value).every(([limitId, limit]) =>
      isQuotaLimit(limit, limitId),
    )
  );
}

function isQuotaSnapshot(value: unknown): value is QuotaSnapshot {
  return (
    isRecord(value) &&
    (value.primary === null ||
      (isQuotaWindow(value.primary) && value.primary.name === "primary")) &&
    (value.secondary === null ||
      (isQuotaWindow(value.secondary) && value.secondary.name === "secondary")) &&
    isNullableString(value.rateLimitReachedType) &&
    (!Object.hasOwn(value, "rateLimitsByLimitId") ||
      isQuotaLimitsById(value.rateLimitsByLimitId)) &&
    isFiniteNumber(value.capturedAt)
  );
}

function isQuotaWait(value: unknown): value is QuotaWait {
  return (
    isRecord(value) &&
    typeof value.failedTurnId === "string" &&
    Array.isArray(value.blockedWindows) &&
    value.blockedWindows.every(isQuotaWindow) &&
    (value.resumeAfter === null || isFiniteNumber(value.resumeAfter)) &&
    isFiniteNumber(value.attemptCount) &&
    typeof value.idempotencyKey === "string"
  );
}

function isAttentionCode(value: unknown): value is AttentionCode | null {
  return (
    value === null ||
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

function isResumeAttempt(value: unknown): value is ResumeAttempt {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    (value.phase === "prepared" ||
      value.phase === "started" ||
      value.phase === "confirmed") &&
    typeof value.failedTurnId === "string" &&
    isFiniteNumber(value.preparedAt) &&
    (value.startedAt === null || isFiniteNumber(value.startedAt)) &&
    isNullableString(value.startedTurnId) &&
    (value.confirmedAt === null || isFiniteNumber(value.confirmedAt))
  );
}

function isWatchedThreadStatus(value: unknown): value is WatchedThreadStatus {
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

function isThreadGoalStatus(value: unknown): value is ThreadGoalStatus {
  return (
    value === "active" ||
    value === "paused" ||
    value === "blocked" ||
    value === "usageLimited" ||
    value === "budgetLimited" ||
    value === "complete"
  );
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

function isGuardianEvent(value: unknown): value is GuardianEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isGuardianEventType(value.type) &&
    typeof value.threadId === "string" &&
    isNullableString(value.turnId) &&
    typeof value.message === "string" &&
    isFiniteNumber(value.at)
  );
}

export function isWatchedThread(value: unknown): value is WatchedThread {
  return (
    isRecord(value) &&
    typeof value.threadId === "string" &&
    typeof value.cwd === "string" &&
    isNullableString(value.title) &&
    isNullableString(value.codexVersion) &&
    typeof value.enabled === "boolean" &&
    isWatchedThreadStatus(value.status) &&
    (value.quotaWait === null || isQuotaWait(value.quotaWait)) &&
    (value.resumeAttempt === null || isResumeAttempt(value.resumeAttempt)) &&
    isNullableString(value.lastObservedTurnId) &&
    (!Object.hasOwn(value, "goalObjective") || isNullableString(value.goalObjective)) &&
    (!Object.hasOwn(value, "goalStatus") ||
      value.goalStatus === null ||
      isThreadGoalStatus(value.goalStatus)) &&
    (!Object.hasOwn(value, "lastResult") ||
      value.lastResult === null ||
      isTaskOutput(value.lastResult)) &&
    (!Object.hasOwn(value, "controlTurnIds") ||
      (Array.isArray(value.controlTurnIds) &&
        value.controlTurnIds.every((id) => typeof id === "string" && id.length > 0))) &&
    (!Object.hasOwn(value, "attentionCode") || isAttentionCode(value.attentionCode)) &&
    isNullableString(value.attentionReason) &&
    (!Object.hasOwn(value, "lastSuccessfulCheckAt") ||
      value.lastSuccessfulCheckAt === null ||
      isFiniteNumber(value.lastSuccessfulCheckAt)) &&
    isFiniteNumber(value.registeredAt) &&
    isFiniteNumber(value.updatedAt)
  );
}

export function createEmptyStateV2(now: number = Date.now()): AppStateV2 {
  return {
    version: 2,
    watchedThreads: [],
    quota: null,
    completedResumeKeys: [],
    events: [],
    updatedAt: now,
  };
}

/**
 * Returns the minimum state that may be written to disk.
 *
 * The guardian can retain richer data in memory for the current process, but
 * task content, result content, and free-form diagnostics must never cross the
 * persistence boundary.
 */
export function privacySafeAppState(state: AppStateV2): AppStateV2 {
  return {
    version: 2,
    watchedThreads: state.watchedThreads.map((thread) => ({
      ...structuredClone(thread),
      title: null,
      goalObjective: null,
      lastResult: null,
      attentionReason: privacySafeAttentionReason(thread),
    })),
    quota: state.quota === null ? null : structuredClone(state.quota),
    completedResumeKeys: [...state.completedResumeKeys],
    events: (state.events ?? []).map((event) => ({
      ...event,
      turnId: null,
      message: guardianEventMessage(event.type),
    })),
    updatedAt: state.updatedAt,
  };
}

function privacySafeAttentionReason(thread: WatchedThread): string | null {
  if (thread.status !== "needs_attention") {
    return null;
  }
  switch (thread.attentionCode ?? null) {
    case "needs_input":
      return "任务需要你提供信息后才能继续。";
    case "blocked":
      return "任务遇到无法自动处理的阻塞。";
    case "non_quota_error":
      return "任务因非额度错误暂停。";
    case "invalid_output":
      return "任务结果无法验证，需要人工检查。";
    case "external_activity":
      return "检测到外部操作，自动续跑已暂停。";
    case "version_changed":
      return "Codex 版本发生变化，自动续跑已暂停。";
    case "project_missing":
      return "项目文件夹不可用，自动续跑已暂停。";
    case "interrupted":
      return "自动续跑被中断，需要人工检查。";
    case "runtime_unavailable":
      return "运行环境暂不可用，自动续跑已暂停。";
    case null:
      return "自动续跑已暂停，请回到 Codex 检查。";
  }
}

function isLegacyAppStateV1(value: unknown): value is LegacyAppStateV1 {
  return isRecord(value) && value.version === 1 && Array.isArray(value.tasks);
}

export function isAppStateV2(value: unknown): value is AppStateV2 {
  if (!isRecord(value)) {
    return false;
  }

  const watchedThreads = value.watchedThreads;
  const watchedIds = Array.isArray(watchedThreads)
    ? watchedThreads.map((thread) =>
        isRecord(thread) && typeof thread.threadId === "string"
          ? thread.threadId
          : null,
      )
    : [];

  return (
    value.version === 2 &&
    Array.isArray(watchedThreads) &&
    watchedThreads.every(isWatchedThread) &&
    watchedIds.every((id) => id !== null) &&
    new Set(watchedIds).size === watchedIds.length &&
    (value.quota === null || isQuotaSnapshot(value.quota)) &&
    Array.isArray(value.completedResumeKeys) &&
    value.completedResumeKeys.every((key) => typeof key === "string") &&
    (!Object.hasOwn(value, "events") ||
      (Array.isArray(value.events) && value.events.every(isGuardianEvent))) &&
    isFiniteNumber(value.updatedAt)
  );
}

export type PersistedAppState = LegacyAppStateV1 | AppStateV2;

export function isPersistedAppState(value: unknown): value is PersistedAppState {
  return isLegacyAppStateV1(value) || isAppStateV2(value);
}

/** Upgrades legacy state while discarding obsolete prompt-bearing manager tasks. */
export function upgradeAppStateV2(
  state: PersistedAppState,
  now: number = Date.now(),
): AppStateV2 {
  if (state.version === 2) {
    const { tasks: _discardedLegacyTasks, ...guardianState } = state as AppStateV2 & {
      tasks?: unknown;
    };
    return {
      ...guardianState,
      watchedThreads: state.watchedThreads.map((thread) => ({
        ...thread,
        goalObjective: thread.goalObjective ?? null,
        goalStatus: thread.goalStatus ?? null,
        lastResult: thread.lastResult ?? null,
        controlTurnIds: thread.controlTurnIds ?? [],
        attentionCode: thread.attentionCode ?? null,
        lastSuccessfulCheckAt: thread.lastSuccessfulCheckAt ?? null,
      })),
      events: state.events ?? [],
    };
  }
  return {
    version: 2,
    watchedThreads: [],
    quota: null,
    // V1 keys belong to the retired manager-owned task system and cannot
    // protect any V2 watched thread. Dropping them avoids retaining obsolete
    // thread/turn identifiers.
    completedResumeKeys: [],
    events: [],
    updatedAt: now,
  };
}
