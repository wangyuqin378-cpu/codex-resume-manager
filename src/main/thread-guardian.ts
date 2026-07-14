import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

import {
  areBlockedWindowsRestored,
  makeQuotaWait,
  makeResumeKey,
} from "../core/quota.js";
import {
  projectThread,
  type ProjectedThread,
  type ProjectedTurn,
} from "../core/thread.js";
import { hasUsageLimitError } from "../core/events.js";
import { AtomicJsonStore } from "../core/store.js";
import {
  createEmptyStateV2,
  guardianEventMessage,
  isPersistedAppState,
  privacySafeAppState,
  upgradeAppStateV2,
  type AppStateV2,
  type AttentionCode,
  type GuardianEventType,
  type PersistedAppState,
  type QuotaSnapshot,
  type QuotaWait,
  type ThreadGoalStatus,
  type WatchedThread,
} from "../shared/types.js";

type JsonObject = Record<string, unknown>;

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const QUOTA_RECHECK_DELAY_MS = 60_000;
const TRANSIENT_READ_PREFIX = "暂时无法读取 Codex 线程，将自动重试：";
const MAX_GUARDIAN_EVENTS = 200;
const MAX_CONTROL_TURN_IDS = 64;

export const DESKTOP_RESUME_PROMPT =
  "请先复核当前线程上下文、工作区现状和已经完成的内容，不要重复执行。" +
  "仅从上次因额度中断而未完成的位置继续，完成原任务，并验证原任务的完成标准。" +
    "如果工作其实已经完成，只需验证并总结，不要重做。" +
    "最后必须按系统要求返回 complete、needs_input 或 blocked 的结构化结果，并提供验证证据。";

export interface GuardianStartTurnInput {
  threadId: string;
  prompt: string;
  clientUserMessageId: string;
}

export interface GuardianServerRequestEvent {
  id: string | number;
  method: string;
  params: JsonObject | null;
}

export interface ThreadGuardianAppServerPort {
  start(): Promise<void>;
  readRateLimits(): Promise<QuotaSnapshot>;
  readThread(threadId: string): Promise<JsonObject>;
  resumeThread(threadId: string): Promise<JsonObject>;
  readThreadGoal?(threadId: string): Promise<{
    objective: string;
    status: ThreadGoalStatus;
  } | null>;
  startTurn(input: GuardianStartTurnInput): Promise<JsonObject>;
  onRateLimits?(listener: (snapshot: QuotaSnapshot) => void): () => void;
  onTurnCompleted?(listener: (event: { threadId: string; turn: JsonObject }) => void): () => void;
  onServerRequest?(listener: (event: GuardianServerRequestEvent) => void): () => void;
}

export interface ThreadGuardianOptions {
  statePath: string;
  appServer: ThreadGuardianAppServerPort;
  now?: () => number;
  /** Set to zero to disable periodic polling (useful for tests). */
  pollIntervalMs?: number;
  continuationPrompt?: string;
  directoryExists?: (cwd: string) => Promise<boolean>;
  getCodexVersion?: () => Promise<string | null>;
  onOperationalError?: (error: Error) => void;
}

export type GuardianStateListener = (state: AppStateV2) => void;

/**
 * Guards opt-in Codex Desktop threads without creating a second task system.
 * All thread reads and automatic starts pass through one serialized check loop.
 */
export class ThreadGuardian {
  readonly #appServer: ThreadGuardianAppServerPort;
  readonly #store: AtomicJsonStore<PersistedAppState>;
  readonly #now: () => number;
  readonly #pollIntervalMs: number;
  readonly #continuationPrompt: string;
  readonly #directoryExists: (cwd: string) => Promise<boolean>;
  readonly #getCodexVersion: () => Promise<string | null>;
  readonly #onOperationalError: ((error: Error) => void) | undefined;
  readonly #listeners = new Set<GuardianStateListener>();
  readonly #unsubscribers: Array<() => void> = [];
  readonly #locallyPreparedKeys = new Set<string>();
  readonly #turnStartInFlight = new Set<string>();

  #state: AppStateV2;
  #initializePromise: Promise<void> | null = null;
  #initialized = false;
  #shuttingDown = false;
  #clearing = false;
  #clearPromise: Promise<void> | null = null;
  #persistenceFailed = false;
  #persistenceFailureGeneration = 0;
  #dataGeneration = 0;
  #checkPromise: Promise<void> | null = null;
  #persistTail: Promise<void> = Promise.resolve();
  #pollTimer: NodeJS.Timeout | null = null;
  #wakeTimer: NodeJS.Timeout | null = null;

  constructor(options: ThreadGuardianOptions) {
    this.#appServer = options.appServer;
    this.#now = options.now ?? Date.now;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#continuationPrompt = options.continuationPrompt ?? DESKTOP_RESUME_PROMPT;
    this.#directoryExists = options.directoryExists ?? defaultDirectoryExists;
    this.#getCodexVersion = options.getCodexVersion ?? (async () => null);
    this.#onOperationalError = options.onOperationalError;
    this.#state = createEmptyStateV2(this.#now());
    this.#store = new AtomicJsonStore<PersistedAppState>(
      options.statePath,
      () => createEmptyStateV2(this.#now()),
      isPersistedAppState,
    );
  }

  initialize(): Promise<void> {
    if (this.#initialized) {
      return Promise.resolve();
    }
    if (this.#initializePromise !== null) {
      return this.#initializePromise;
    }
    const pending = this.#initialize();
    this.#initializePromise = pending;
    const clear = (): void => {
      if (this.#initializePromise === pending) {
        this.#initializePromise = null;
      }
    };
    void pending.then(clear, clear);
    return pending;
  }

  async #initialize(): Promise<void> {
    const dataGeneration = this.#dataGeneration;
    const loaded = await this.#store.load();
    if (dataGeneration === this.#dataGeneration && !this.#clearing) {
      this.#state = upgradeAppStateV2(loaded, this.#now());
      // Rewrite every loaded version through the privacy boundary before the
      // guardian connects to Codex. This also cleans older V2 files even if App
      // Server startup later fails. Queue the write so a concurrent explicit
      // privacy clear is always the final disk operation.
      await this.#enqueuePersist(privacySafeAppState(this.#state), false);
    }
    await this.#appServer.start();
    this.#subscribeToServer();
    this.#initialized = true;
    if (this.#pollIntervalMs > 0) {
      this.#pollTimer = setInterval(() => {
        void this.checkNow().catch((error: unknown) => this.#reportOperationalError(error));
      }, this.#pollIntervalMs);
      this.#pollTimer.unref();
    }
    this.#scheduleWake();
  }

  getState(): AppStateV2 {
    return structuredClone(this.#state);
  }

  /** Alias used by the main process when composing its renderer snapshot. */
  getSnapshot(): AppStateV2 {
    return this.getState();
  }

  getThreadStatus(threadId: string): WatchedThread | null {
    const watched = this.#state.watchedThreads.find((entry) => entry.threadId === threadId);
    return watched === undefined ? null : structuredClone(watched);
  }

  onChanged(listener: GuardianStateListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Explicit startup/UI refresh; periodic thread polling does not spend quota reads. */
  async refreshQuota(): Promise<QuotaSnapshot> {
    const dataGeneration = this.#dataGeneration;
    await this.initialize();
    return this.#refreshQuota(dataGeneration);
  }

  async registerThread(
    threadId: string,
    controlTurnId: string | null = null,
  ): Promise<WatchedThread> {
    const dataGeneration = this.#dataGeneration;
    await this.initialize();
    if (threadId.trim().length === 0) {
      throw new TypeError("threadId is required");
    }
    const thread = this.#requireTopLevelThread(
      await this.#appServer.readThread(threadId),
      threadId,
    );
    const now = this.#now();
    const codexVersion = await this.#getCodexVersion();
    let goal: { objective: string; status: ThreadGoalStatus } | null = null;
    if (this.#appServer.readThreadGoal !== undefined) {
      try {
        goal = await this.#appServer.readThreadGoal(threadId);
      } catch (error) {
        this.#reportOperationalError(error);
      }
    }
    if (this.#clearing || dataGeneration !== this.#dataGeneration) {
      throw new Error("Local guardian data was cleared while enabling this thread");
    }
    const latestTurnId = thread.turns.at(-1)?.id ?? null;
    let watched = this.#state.watchedThreads.find((entry) => entry.threadId === threadId);
    if (watched === undefined) {
      watched = {
        threadId,
        cwd: thread.cwd,
        title: thread.title,
        codexVersion,
        enabled: true,
        status: "watching",
        quotaWait: null,
        resumeAttempt: null,
        lastObservedTurnId: latestTurnId,
        goalObjective: goal?.objective ?? null,
        goalStatus: goal?.status ?? null,
        lastResult: null,
        controlTurnIds: controlTurnId === null ? [] : [controlTurnId],
        attentionCode: null,
        attentionReason: null,
        lastSuccessfulCheckAt: now,
        registeredAt: now,
        updatedAt: now,
      };
      this.#state.watchedThreads.push(watched);
    } else {
      const attemptWasActive = this.#isAttemptActive(watched);
      watched.cwd = thread.cwd;
      watched.title = thread.title;
      watched.codexVersion = codexVersion;
      watched.enabled = true;
      watched.status = this.#isAttemptActive(watched) ? "resuming" : "watching";
      watched.goalObjective = goal?.objective ?? watched.goalObjective ?? null;
      watched.goalStatus = goal?.status ?? watched.goalStatus ?? null;
      watched.lastResult = null;
      if (!attemptWasActive) {
        watched.controlTurnIds = [];
      }
      this.#rememberControlTurn(watched, controlTurnId);
      watched.attentionCode = null;
      watched.attentionReason = null;
      watched.lastObservedTurnId = latestTurnId;
      watched.lastSuccessfulCheckAt = now;
      if (!attemptWasActive) {
        watched.quotaWait = null;
        watched.resumeAttempt = null;
      }
      watched.updatedAt = now;
    }
    this.#recordEvent(
      "guarding_enabled",
      watched,
      latestTurnId,
    );
    await this.#commit();
    return structuredClone(watched);
  }

  async enableThread(
    threadId: string,
    controlTurnId: string | null = null,
  ): Promise<WatchedThread> {
    return this.registerThread(threadId, controlTurnId);
  }

  async noteControlTurn(threadId: string, turnId: string | null): Promise<void> {
    await this.initialize();
    if (turnId === null) {
      return;
    }
    const watched = this.#state.watchedThreads.find((entry) => entry.threadId === threadId);
    if (watched === undefined) {
      return;
    }
    if (this.#rememberControlTurn(watched, turnId)) {
      watched.updatedAt = this.#now();
      await this.#commit();
    }
  }

  async disableThread(threadId: string): Promise<void> {
    await this.initialize();
    const watched = this.#requireWatched(threadId);
    const attempt = watched.resumeAttempt;
    const cancellableLocalPrepare =
      attempt?.phase === "prepared" &&
      this.#locallyPreparedKeys.has(attempt.key) &&
      !this.#turnStartInFlight.has(attempt.key);
    if (cancellableLocalPrepare && attempt !== null) {
      attempt.phase = "confirmed";
      attempt.confirmedAt = this.#now();
      this.#locallyPreparedKeys.delete(attempt.key);
    }
    const attemptActive = this.#isAttemptActive(watched);
    watched.enabled = false;
    watched.status = attemptActive ? "resuming" : "disabled";
    if (!attemptActive) {
      watched.quotaWait = null;
    }
    watched.attentionReason = null;
    watched.attentionCode = null;
    watched.updatedAt = this.#now();
    this.#recordEvent(
      "guarding_disabled",
      watched,
    );
    await this.#commit();
  }

  async removeThread(threadId: string): Promise<void> {
    await this.initialize();
    const index = this.#state.watchedThreads.findIndex((entry) => entry.threadId === threadId);
    if (index >= 0) {
      const watched = this.#state.watchedThreads[index] as WatchedThread;
      if (this.#isAttemptActive(watched)) {
        const attempt = watched.resumeAttempt;
        const cancellableLocalPrepare =
          attempt?.phase === "prepared" &&
          this.#locallyPreparedKeys.has(attempt.key) &&
          !this.#turnStartInFlight.has(attempt.key);
        if (!cancellableLocalPrepare || attempt === null) {
          throw new Error("Cannot remove a thread while its automatic turn is active");
        }
        this.#locallyPreparedKeys.delete(attempt.key);
      }
      this.#state.watchedThreads.splice(index, 1);
    }

    const previousEventCount = this.#state.events?.length ?? 0;
    this.#state.events = (this.#state.events ?? []).filter(
      (event) => event.threadId !== threadId,
    );
    const previousKeyCount = this.#state.completedResumeKeys.length;
    this.#state.completedResumeKeys = this.#state.completedResumeKeys.filter(
      (key) => !resumeKeyBelongsToThread(key, threadId),
    );
    if (
      index < 0 &&
      previousEventCount === this.#state.events.length &&
      previousKeyCount === this.#state.completedResumeKeys.length
    ) {
      return;
    }
    await this.#commit();
  }

  async clearAllLocalData(): Promise<void> {
    if (this.#clearPromise !== null) {
      return this.#clearPromise;
    }
    if (this.#hasActiveResume()) {
      throw new Error("Cannot clear local data while an automatic turn is active");
    }
    this.#clearing = true;
    this.#dataGeneration += 1;
    const empty = createEmptyStateV2(this.#now());
    this.#state = empty;
    this.#locallyPreparedKeys.clear();

    const pending = (async () => {
      try {
        // replace() is deliberately allowed to overwrite corrupt, oversized,
        // or otherwise unreadable state. A privacy clear must not require a
        // working App Server or a parseable previous file.
        await this.#enqueuePersist(privacySafeAppState(empty), true);
        this.#persistenceFailed = false;
        this.#emitChanged();
      } finally {
        this.#clearing = false;
        this.#scheduleWake();
      }
    })();
    this.#clearPromise = pending;
    try {
      await pending;
    } finally {
      if (this.#clearPromise === pending) {
        this.#clearPromise = null;
      }
    }
  }

  checkNow(): Promise<void> {
    if (this.#clearing) {
      return Promise.resolve();
    }
    if (this.#checkPromise !== null) {
      return this.#checkPromise;
    }
    const pending = this.#runCheck().finally(() => {
      if (this.#checkPromise === pending) {
        this.#checkPromise = null;
      }
    });
    this.#checkPromise = pending;
    return pending;
  }

  async #runCheck(): Promise<void> {
    await this.initialize();
    if (this.#shuttingDown || this.#clearing) {
      return;
    }

    const active = this.#orderedThreads().find((thread) => this.#isAttemptActive(thread));
    if (active !== undefined) {
      const stillActive = await this.#recoverAttempt(active);
      if (stillActive) {
        return;
      }
    }

    // A failed state write makes every new automatic action unsafe: after a
    // crash we could not prove which checkpoint was durable. Existing active
    // turns may still be observed above, but no new turn may be started until
    // a later successful write or an explicit privacy clear restores safety.
    if (this.#persistenceFailed) {
      return;
    }

    let quotaForFailure: QuotaSnapshot | null = null;
    const temporarilyUnreadable = new Set<string>();
    for (const watched of this.#orderedThreads()) {
      if (!watched.enabled || this.#isAttemptActive(watched)) {
        continue;
      }
      let rawThread: JsonObject;
      try {
        rawThread = await this.#appServer.readThread(watched.threadId);
      } catch (error) {
        // A missing, archived, or otherwise unreadable ordinary thread must
        // not starve every later watched thread. Active resume attempts are
        // handled separately above and remain fail-closed/global-blocking.
        watched.attentionReason = `${TRANSIENT_READ_PREFIX}${errorMessage(error)}`;
        watched.updatedAt = this.#now();
        temporarilyUnreadable.add(watched.threadId);
        await this.#commit();
        continue;
      }
      if (this.#clearing || !this.#state.watchedThreads.includes(watched)) {
        continue;
      }
      const thread = this.#projectOrAttention(watched, rawThread);
      if (thread === null) {
        continue;
      }
      const latest = thread.turns.at(-1) ?? null;
      watched.cwd = thread.cwd;
      watched.title = thread.title;
      watched.lastObservedTurnId = latest?.id ?? null;
      watched.lastSuccessfulCheckAt = this.#now();
      watched.updatedAt = this.#now();
      if (watched.attentionReason?.startsWith(TRANSIENT_READ_PREFIX)) {
        watched.attentionReason = null;
      }

      if (
        watched.quotaWait !== null &&
        latest?.id !== watched.quotaWait.failedTurnId &&
        !this.#hasSafeControlTail(thread, watched.quotaWait.failedTurnId, watched)
      ) {
        this.#markExternalActivity(watched);
        await this.#commit();
        continue;
      }

      const failure = this.#latestTaskUsageLimitFailure(thread, watched);
      if (
        failure !== null &&
        watched.quotaWait?.failedTurnId === failure.id &&
        watched.quotaWait.resumeAfter === null
      ) {
        quotaForFailure ??= await this.#refreshQuota();
        if (this.#clearing || !this.#state.watchedThreads.includes(watched)) {
          continue;
        }
        this.#setQuotaWait(
          watched,
          failure.id,
          quotaForFailure,
          watched.quotaWait.attemptCount,
        );
        await this.#commit();
        continue;
      }
      if (failure === null || watched.quotaWait?.failedTurnId === failure.id) {
        continue;
      }

      quotaForFailure ??= await this.#refreshQuota();
      if (this.#clearing || !this.#state.watchedThreads.includes(watched)) {
        continue;
      }
      const previousAttempts = watched.quotaWait?.attemptCount ?? 0;
      this.#setQuotaWait(
        watched,
        failure.id,
        quotaForFailure,
        previousAttempts + 1,
      );
      await this.#commit();
    }

    const due = this.#orderedThreads().find(
      (thread) =>
        thread.enabled &&
        thread.status === "waiting_quota" &&
        thread.quotaWait !== null &&
        thread.quotaWait.resumeAfter !== null &&
        !temporarilyUnreadable.has(thread.threadId) &&
        thread.quotaWait.resumeAfter <= this.#now(),
    );
    if (due === undefined || due.quotaWait === null) {
      this.#scheduleWake();
      return;
    }
    await this.#resumeDueThread(due);
  }

  async #resumeDueThread(watched: WatchedThread): Promise<void> {
    if (this.#clearing || this.#persistenceFailed) {
      return;
    }
    const wait = watched.quotaWait;
    if (wait === null) {
      return;
    }
    let currentVersion: string | null;
    try {
      currentVersion = await this.#getCodexVersion();
    } catch (error) {
      this.#needsAttention(
        watched,
        `恢复前无法确认 Codex 版本：${errorMessage(error)}`,
      );
      await this.#commit();
      return;
    }
    if (!this.#isCurrentWait(watched, wait)) {
      return;
    }
    if (
      watched.codexVersion !== null &&
      currentVersion !== null &&
      watched.codexVersion !== currentVersion
    ) {
      this.#needsAttention(
        watched,
        `Codex 已从 ${watched.codexVersion} 变为 ${currentVersion}；请重新开启守护以确认兼容性。`,
        "version_changed",
      );
      await this.#commit();
      return;
    }
    const directoryExists = await this.#directoryExists(watched.cwd);
    if (!this.#isCurrentWait(watched, wait)) {
      return;
    }
    if (!directoryExists) {
      this.#needsAttention(
        watched,
        `项目文件夹不存在或不可访问：${watched.cwd}`,
        "project_missing",
      );
      await this.#commit();
      return;
    }
    const snapshot = await this.#refreshQuota();
    if (!this.#isCurrentWait(watched, wait)) {
      return;
    }
    if (!areBlockedWindowsRestored(wait, snapshot, this.#now())) {
      const replacement = makeQuotaWait(
        watched.threadId,
        wait.failedTurnId,
        snapshot,
        wait.attemptCount,
      );
      if (replacement === null) {
        watched.quotaWait = this.#pendingQuotaWait(
          watched.threadId,
          wait.failedTurnId,
          wait.attemptCount,
        );
        watched.status = "waiting_quota_data";
        watched.attentionReason = null;
        watched.updatedAt = this.#now();
        this.#recordEvent(
          "quota_data_pending",
          watched,
          wait.failedTurnId,
        );
      } else {
        if (replacement.resumeAfter !== null && replacement.resumeAfter <= this.#now()) {
          replacement.resumeAfter = this.#now() + QUOTA_RECHECK_DELAY_MS;
        }
        watched.quotaWait = replacement;
        watched.status = replacement.resumeAfter === null
          ? "waiting_quota_data"
          : "waiting_quota";
        watched.updatedAt = this.#now();
      }
      await this.#commit();
      return;
    }

    const beforeResumeRaw = await this.#appServer.readThread(watched.threadId);
    if (!this.#isCurrentWait(watched, wait)) {
      return;
    }
    const beforeResume = this.#projectOrAttention(watched, beforeResumeRaw);
    if (beforeResume === null) {
      await this.#commit();
      return;
    }
    const latest = beforeResume.turns.at(-1) ?? null;
    if (!this.#hasSafeControlTail(beforeResume, wait.failedTurnId, watched)) {
      this.#markExternalActivity(watched);
      await this.#commit();
      return;
    }
    // A disk-backed thread is commonly `notLoaded` in this independent App
    // Server. Both `idle` and `notLoaded` are safe to rejoin; `active` is not.
    if (beforeResume.status === "active" || latest?.status === "inProgress") {
      return;
    }
    if (beforeResume.status === "systemError") {
      this.#needsAttention(watched, "线程处于系统错误状态；自动续跑已关闭。 ");
      await this.#commit();
      return;
    }
    await this.#refreshGoal(watched);
    if (!this.#isCurrentWait(watched, wait)) {
      return;
    }

    watched.resumeAttempt = {
      key: wait.idempotencyKey,
      phase: "prepared",
      failedTurnId: wait.failedTurnId,
      preparedAt: this.#now(),
      startedAt: null,
      startedTurnId: null,
      confirmedAt: null,
    };
    this.#locallyPreparedKeys.add(wait.idempotencyKey);
    watched.status = "resuming";
    watched.updatedAt = this.#now();
    await this.#commit();
    await this.#dispatchPreparedAttempt(watched);
  }

  async #dispatchPreparedAttempt(watched: WatchedThread): Promise<void> {
    const attempt = watched.resumeAttempt;
    if (attempt === null || attempt.phase !== "prepared") {
      return;
    }
    let startTurnInvoked = false;
    try {
      const resumedRaw = await this.#appServer.resumeThread(watched.threadId);
      if (
        this.#shuttingDown ||
        this.#clearing ||
        this.#persistenceFailed ||
        !watched.enabled ||
        watched.resumeAttempt !== attempt ||
        attempt.phase !== "prepared" ||
        !this.#state.watchedThreads.includes(watched)
      ) {
        return;
      }
      const resumed = this.#requireTopLevelThread(resumedRaw, watched.threadId);
      if (
        resumed.status === "active" ||
        !this.#hasSafeControlTail(resumed, attempt.failedTurnId, watched)
      ) {
        this.#markExternalActivity(watched);
        await this.#commit();
        return;
      }

      if (!watched.enabled) {
        attempt.phase = "confirmed";
        attempt.confirmedAt = this.#now();
        watched.quotaWait = null;
        watched.status = "disabled";
        watched.updatedAt = this.#now();
        await this.#commit();
        return;
      }

      this.#turnStartInFlight.add(attempt.key);
      let turn: JsonObject;
      try {
        const goalContext = watched.goalObjective?.trim()
          ? `\n当前 Codex 目标：${watched.goalObjective.trim()}`
          : "\n当前没有单独的 /goal 记录，请以本线程原始任务和完成标准为准。";
        startTurnInvoked = true;
        turn = await this.#appServer.startTurn({
          threadId: watched.threadId,
          prompt: `${this.#continuationPrompt}${goalContext}`,
          clientUserMessageId: clientMessageId(attempt.key),
        });
      } finally {
        this.#turnStartInFlight.delete(attempt.key);
      }
      if (typeof turn.id !== "string" || turn.id.length === 0) {
        throw new Error("Codex App Server returned turn/start without a turn id");
      }
      attempt.phase = "started";
      attempt.startedAt = this.#now();
      attempt.startedTurnId = turn.id;
      watched.lastObservedTurnId = turn.id;
      watched.status = "resuming";
      watched.updatedAt = this.#now();
      this.#recordEvent(
        "resume_started",
        watched,
        turn.id,
      );
      await this.#commit();
    } catch (error) {
      if (this.#persistenceFailed) {
        // The Codex request may already have been accepted. Keep its active
        // checkpoint for observation and never convert it into a retryable
        // state merely because the local state write failed.
        this.#reportOperationalError(error);
        return;
      }
      if (!startTurnInvoked) {
        // resumeThread and the pre-start validation path are read/rejoin-only.
        // If one of them fails, turn/start was provably never invoked, so this
        // checkpoint can be closed without blocking unrelated due tasks.
        attempt.phase = "confirmed";
        attempt.confirmedAt = this.#now();
        this.#locallyPreparedKeys.delete(attempt.key);
        this.#needsAttention(
          watched,
          "自动续跑准备失败，本次未发起新的 turn；该任务已停止自动处理。",
          "runtime_unavailable",
        );
        this.#reportOperationalError(error);
        await this.#commit();
        return;
      }
      // `clientUserMessageId` is correlation metadata, not an idempotency
      // guarantee. The server may have accepted turn/start before the client
      // observed this failure, so keep the prepared checkpoint active. A later
      // thread/read must observe the possible new turn through a terminal state
      // before the global automatic-start lock can be released.
      this.#locallyPreparedKeys.delete(attempt.key);
      this.#needsAttention(
        watched,
        "自动续跑请求结果不确定；将继续观察线程，但不会重试或启动其他自动任务。",
        "runtime_unavailable",
      );
      this.#reportOperationalError(error);
      await this.#commit();
    } finally {
      this.#locallyPreparedKeys.delete(attempt.key);
    }
  }

  /** Returns true while this attempt must block every other automatic start. */
  async #recoverAttempt(watched: WatchedThread): Promise<boolean> {
    const attempt = watched.resumeAttempt;
    if (attempt === null || attempt.phase === "confirmed") {
      return false;
    }
    const rawThread = await this.#appServer.readThread(watched.threadId);
    if (this.#clearing || !this.#state.watchedThreads.includes(watched)) {
      return false;
    }
    const thread = this.#projectOrAttention(watched, rawThread);
    if (thread === null) {
      await this.#commit();
      return true;
    }
    const latest = thread.turns.at(-1) ?? null;
    watched.lastObservedTurnId = latest?.id ?? null;
    watched.lastSuccessfulCheckAt = this.#now();
    watched.updatedAt = this.#now();

    if (attempt.phase === "prepared") {
      if (latest === null || latest.id === attempt.failedTurnId) {
        // The request can be accepted before its new turn becomes visible to
        // thread/read. An unchanged failed turn therefore cannot prove that no
        // work is running (or about to appear). Keep this checkpoint active and
        // fail closed globally; do not replay turn/start.
        this.#needsAttention(
          watched,
          "无法证明自动续跑请求是否送达；将继续观察线程，但不会重试或启动其他自动任务。",
        );
        await this.#commit();
        return true;
      }
      if (latest !== null && (latest.status === "inProgress" || thread.status === "active")) {
        attempt.phase = "started";
        attempt.startedAt = attempt.startedAt ?? this.#now();
        attempt.startedTurnId = latest.id;
        this.#markExternalActivity(watched);
        await this.#commit();
        return true;
      }
      attempt.phase = "confirmed";
      attempt.confirmedAt = this.#now();
      this.#markExternalActivity(watched);
      await this.#commit();
      return false;
    }

    if (attempt.startedTurnId === null || latest === null) {
      this.#needsAttention(
        watched,
        "暂时无法找到自动续跑 turn；将继续观察线程，但不会启动其他自动任务。",
      );
      await this.#commit();
      return true;
    }
    const startedIndex = thread.turns.findIndex(
      (turn) => turn.id === attempt.startedTurnId,
    );
    if (startedIndex < 0) {
      this.#needsAttention(
        watched,
        "暂时无法在该线程中找到自动续跑 turn；将继续观察，但不会启动其他自动任务。",
      );
      await this.#commit();
      return true;
    }
    const startedTurn = thread.turns[startedIndex] as ProjectedTurn;
    const controls = new Set(watched.controlTurnIds ?? []);
    const trailingTurns = thread.turns.slice(startedIndex + 1);
    const hasExternalTrailingTurn = trailingTurns.some((turn) => !controls.has(turn.id));
    if (
      startedTurn.status === "inProgress" ||
      trailingTurns.some((turn) => turn.status === "inProgress") ||
      thread.status === "active"
    ) {
      if (hasExternalTrailingTurn && watched.status !== "needs_attention") {
        this.#markExternalActivity(watched);
        await this.#commit();
      }
      return true;
    }

    if (hasExternalTrailingTurn) {
      this.#confirmAttempt(watched, true);
      this.#markExternalActivity(watched);
      await this.#commit();
      return false;
    }

    if (watched.status === "needs_attention") {
      this.#confirmAttempt(watched, true);
      await this.#commit();
      return false;
    }
    if (startedTurn.status === "completed") {
      const output = startedTurn.output;
      this.#confirmAttempt(watched, true);
      watched.lastResult = output;
      this.#recordEvent(
        "resume_completed",
        watched,
        startedTurn.id,
      );
      if (output === null) {
        this.#needsAttention(
          watched,
          "自动续跑已结束，但没有返回可验证的结构化结果；请回到 Codex 检查任务。",
          "invalid_output",
        );
      } else if (output.status === "complete") {
        watched.enabled = false;
        watched.status = "completed";
        watched.goalStatus = "complete";
        watched.attentionCode = null;
        watched.attentionReason = null;
        watched.updatedAt = this.#now();
        this.#recordEvent(
          "goal_completed",
          watched,
          startedTurn.id,
        );
      } else {
        this.#needsAttention(
          watched,
          output.message,
          output.status === "needs_input" ? "needs_input" : "blocked",
        );
      }
      await this.#commit();
      return false;
    }
    if (
      isUsageLimitFailure(startedTurn)
    ) {
      const previousAttempts = watched.quotaWait?.attemptCount ?? 1;
      this.#confirmAttempt(watched, true);
      const snapshot = await this.#refreshQuota();
      this.#setQuotaWait(
        watched,
        startedTurn.id,
        snapshot,
        previousAttempts + 1,
      );
      await this.#commit();
      return false;
    }

    this.#confirmAttempt(watched, true);
    this.#needsAttention(
      watched,
      startedTurn.status === "interrupted"
        ? "自动续跑 turn 被中断；请检查工作区后再决定是否继续。"
        : "自动续跑 turn 以非额度错误失败；请检查线程和工作区。",
      startedTurn.status === "interrupted" ? "interrupted" : "non_quota_error",
    );
    await this.#commit();
    return false;
  }

  #confirmAttempt(watched: WatchedThread, completed: boolean): void {
    const attempt = watched.resumeAttempt;
    if (attempt === null) {
      return;
    }
    const preserveAttention =
      watched.status === "needs_attention" || watched.attentionReason !== null;
    attempt.phase = "confirmed";
    attempt.confirmedAt = this.#now();
    if (completed && !this.#state.completedResumeKeys.includes(attempt.key)) {
      this.#state.completedResumeKeys.push(attempt.key);
    }
    watched.quotaWait = null;
    if (preserveAttention) {
      watched.enabled = false;
      watched.status = "needs_attention";
    } else {
      watched.status = watched.enabled ? "watching" : "disabled";
      watched.attentionCode = null;
      watched.attentionReason = null;
    }
    watched.updatedAt = this.#now();
  }

  #setQuotaWait(
    watched: WatchedThread,
    failedTurnId: string,
    snapshot: QuotaSnapshot,
    attemptCount: number,
  ): void {
    const nonRecoverableReason = nonRecoverableQuotaReason(snapshot);
    if (nonRecoverableReason !== null) {
      this.#needsAttention(watched, nonRecoverableReason, "blocked");
      return;
    }
    const wait = makeQuotaWait(
      watched.threadId,
      failedTurnId,
      snapshot,
      attemptCount,
    ) ?? this.#pendingQuotaWait(watched.threadId, failedTurnId, attemptCount);
    if (this.#state.completedResumeKeys.includes(wait.idempotencyKey)) {
      this.#needsAttention(
        watched,
        "这个额度断点已经恢复过；为避免重复执行，自动续跑已关闭。",
        "external_activity",
      );
      return;
    }

    watched.quotaWait = wait;
    watched.status = wait.resumeAfter === null ? "waiting_quota_data" : "waiting_quota";
    watched.attentionCode = null;
    watched.attentionReason = null;
    watched.updatedAt = this.#now();
    this.#recordEvent(
      wait.resumeAfter === null ? "quota_data_pending" : "quota_detected",
      watched,
      failedTurnId,
    );
    if (wait.resumeAfter !== null) {
      this.#recordEvent(
        "resume_scheduled",
        watched,
        failedTurnId,
      );
    }
  }

  #pendingQuotaWait(
    threadId: string,
    failedTurnId: string,
    attemptCount: number,
  ): QuotaWait {
    return {
      failedTurnId,
      blockedWindows: [],
      resumeAfter: null,
      attemptCount,
      idempotencyKey: makeResumeKey(threadId, failedTurnId, null),
    };
  }

  async #refreshQuota(dataGeneration = this.#dataGeneration): Promise<QuotaSnapshot> {
    const snapshot = await this.#appServer.readRateLimits();
    if (
      this.#clearing ||
      dataGeneration !== this.#dataGeneration ||
      this.#persistenceFailed
    ) {
      return snapshot;
    }
    this.#state.quota = snapshot;
    await this.#commit();
    return snapshot;
  }

  #projectOrAttention(
    watched: WatchedThread,
    value: unknown,
  ): ProjectedThread | null {
    const thread = projectThread(value);
    if (thread === null || thread.id !== watched.threadId) {
      this.#needsAttention(watched, "Codex 返回的线程结构无效；自动续跑已关闭。 ");
      return null;
    }
    if (thread.parentThreadId !== null) {
      this.#needsAttention(watched, "子代理线程不能自动续跑；只守护顶层 Codex 任务。 ");
      return null;
    }
    return thread;
  }

  #requireTopLevelThread(value: unknown, expectedId: string): ProjectedThread {
    const thread = projectThread(value);
    if (thread === null || thread.id !== expectedId) {
      throw new Error("Codex returned an invalid thread response");
    }
    if (thread.parentThreadId !== null) {
      throw new Error("Only a top-level Codex thread can be guarded");
    }
    return thread;
  }

  #markExternalActivity(watched: WatchedThread): void {
    watched.enabled = false;
    watched.status = "needs_attention";
    watched.quotaWait = null;
    watched.attentionCode = "external_activity";
    watched.attentionReason =
      "检测到外部或手动继续操作，自动续跑已关闭；确认线程状态后可重新开启。";
    watched.updatedAt = this.#now();
    this.#recordEvent(
      "external_activity",
      watched,
      watched.lastObservedTurnId,
    );
  }

  #needsAttention(
    watched: WatchedThread,
    reason: string,
    code: AttentionCode = "runtime_unavailable",
  ): void {
    watched.enabled = false;
    watched.status = "needs_attention";
    watched.quotaWait = null;
    watched.attentionCode = code;
    watched.attentionReason = reason.trim();
    watched.updatedAt = this.#now();
    this.#recordEvent(
      "needs_attention",
      watched,
      watched.lastObservedTurnId,
    );
  }

  #recordEvent(
    type: GuardianEventType,
    watched: WatchedThread,
    turnId: string | null = null,
  ): void {
    const events = this.#state.events ?? (this.#state.events = []);
    const at = this.#now();
    const message = guardianEventMessage(type);
    const previous = events.at(-1);
    if (
      previous?.type === type &&
      previous.threadId === watched.threadId &&
      previous.turnId === turnId &&
      previous.message === message
    ) {
      return;
    }
    events.push({
      id: `${at}-${events.length}-${type}`,
      type,
      threadId: watched.threadId,
      turnId,
      message,
      at,
    });
    if (events.length > MAX_GUARDIAN_EVENTS) {
      events.splice(0, events.length - MAX_GUARDIAN_EVENTS);
    }
  }

  #requireWatched(threadId: string): WatchedThread {
    const watched = this.#state.watchedThreads.find((entry) => entry.threadId === threadId);
    if (watched === undefined) {
      throw new Error(`Thread is not guarded: ${threadId}`);
    }
    return watched;
  }

  #orderedThreads(): WatchedThread[] {
    return [...this.#state.watchedThreads].sort(
      (left, right) =>
        left.registeredAt - right.registeredAt ||
        left.threadId.localeCompare(right.threadId),
    );
  }

  #rememberControlTurn(watched: WatchedThread, turnId: string | null): boolean {
    if (turnId === null || turnId.length === 0) {
      return false;
    }
    const controlTurnIds = watched.controlTurnIds ?? (watched.controlTurnIds = []);
    if (controlTurnIds.includes(turnId)) {
      return false;
    }
    controlTurnIds.push(turnId);
    if (controlTurnIds.length > MAX_CONTROL_TURN_IDS) {
      controlTurnIds.splice(0, controlTurnIds.length - MAX_CONTROL_TURN_IDS);
    }
    return true;
  }

  #latestTaskUsageLimitFailure(
    thread: ProjectedThread,
    watched: WatchedThread,
  ): ProjectedTurn | null {
    const controls = new Set(watched.controlTurnIds ?? []);
    for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
      const turn = thread.turns[index] as ProjectedTurn;
      if (controls.has(turn.id)) {
        continue;
      }
      return isUsageLimitFailure(turn) ? turn : null;
    }
    return null;
  }

  #hasSafeControlTail(
    thread: ProjectedThread,
    failedTurnId: string,
    watched: WatchedThread,
  ): boolean {
    const failedIndex = thread.turns.findIndex((turn) => turn.id === failedTurnId);
    if (failedIndex < 0) {
      return false;
    }
    const failedTurn = thread.turns[failedIndex] as ProjectedTurn;
    if (!isUsageLimitFailure(failedTurn)) {
      return false;
    }
    const controls = new Set(watched.controlTurnIds ?? []);
    return thread.turns
      .slice(failedIndex + 1)
      .every((turn) => controls.has(turn.id));
  }

  #isAttemptActive(watched: WatchedThread): boolean {
    return watched.resumeAttempt !== null && watched.resumeAttempt.phase !== "confirmed";
  }

  #hasActiveResume(): boolean {
    return (
      this.#turnStartInFlight.size > 0 ||
      this.#state.watchedThreads.some((watched) => this.#isAttemptActive(watched))
    );
  }

  async #refreshGoal(watched: WatchedThread): Promise<void> {
    if (this.#appServer.readThreadGoal === undefined) {
      return;
    }
    try {
      const goal = await this.#appServer.readThreadGoal(watched.threadId);
      if (!this.#state.watchedThreads.includes(watched)) {
        return;
      }
      watched.goalObjective = goal?.objective ?? null;
      watched.goalStatus = goal?.status ?? null;
    } catch (error) {
      this.#reportOperationalError(error);
    }
  }

  #isCurrentWait(watched: WatchedThread, wait: NonNullable<WatchedThread["quotaWait"]>): boolean {
    return (
      !this.#shuttingDown &&
      !this.#clearing &&
      !this.#persistenceFailed &&
      watched.enabled &&
      watched.quotaWait === wait &&
      this.#state.watchedThreads.includes(watched)
    );
  }

  #subscribeToServer(): void {
    if (this.#appServer.onRateLimits !== undefined) {
      this.#unsubscribers.push(
        this.#appServer.onRateLimits((snapshot) => {
          if (this.#clearing || this.#persistenceFailed) {
            return;
          }
          this.#state.quota = snapshot;
          void this.#commit()
            .then(() => this.checkNow())
            .catch((error: unknown) => this.#reportOperationalError(error));
        }),
      );
    }
    if (this.#appServer.onTurnCompleted !== undefined) {
      this.#unsubscribers.push(
        this.#appServer.onTurnCompleted((event) => {
          if (
            !this.#clearing &&
            this.#state.watchedThreads.some((entry) => entry.threadId === event.threadId)
          ) {
            void this.checkNow().catch((error: unknown) => this.#reportOperationalError(error));
          }
        }),
      );
    }
    if (this.#appServer.onServerRequest !== undefined) {
      this.#unsubscribers.push(
        this.#appServer.onServerRequest((event) => {
          void this.#handleServerRequest(event).catch((error: unknown) =>
            this.#reportOperationalError(error),
          );
        }),
      );
    }
  }

  async #handleServerRequest(event: GuardianServerRequestEvent): Promise<void> {
    if (this.#clearing) {
      return;
    }
    const explicitThreadId = typeof event.params?.threadId === "string"
      ? event.params.threadId
      : null;
    const watched = explicitThreadId === null
      ? this.#state.watchedThreads.find((entry) => this.#isAttemptActive(entry))
      : this.#state.watchedThreads.find((entry) => entry.threadId === explicitThreadId);
    if (watched === undefined) {
      return;
    }
    this.#needsAttention(
      watched,
      `自动续跑遇到需要人工处理的请求（${event.method}）；未代替你做决定。`,
    );
    await this.#commit();
  }

  async #commit(): Promise<void> {
    this.#state.updatedAt = this.#now();
    const snapshot = privacySafeAppState(this.#state);
    await this.#enqueuePersist(snapshot, false);
    this.#emitChanged();
    this.#scheduleWake();
  }

  #enqueuePersist(snapshot: PersistedAppState, replace: boolean): Promise<void> {
    const expectedFailureGeneration = this.#persistenceFailureGeneration;
    const write = this.#persistTail.catch(() => undefined).then(async () => {
      if (!replace && expectedFailureGeneration !== this.#persistenceFailureGeneration) {
        throw new Error("State write was superseded by an earlier persistence failure");
      }
      try {
        if (replace) {
          await this.#store.replace(snapshot);
        } else {
          await this.#store.save(snapshot);
        }
        this.#persistenceFailed = false;
      } catch (error) {
        this.#enterPersistenceFailure();
        throw error;
      }
    });
    this.#persistTail = write;
    return write;
  }

  #enterPersistenceFailure(): void {
    // Advance on every failed physical write so any already-queued snapshot
    // can never become durable after a newer failure changed memory to the
    // fail-closed state.
    this.#persistenceFailureGeneration += 1;
    this.#persistenceFailed = true;
    const now = this.#now();
    for (const watched of this.#state.watchedThreads) {
      const attempt = watched.resumeAttempt;
      const localPrepared =
        attempt?.phase === "prepared" &&
        this.#locallyPreparedKeys.has(attempt.key) &&
        !this.#turnStartInFlight.has(attempt.key);
      if (localPrepared && attempt !== null) {
        attempt.phase = "confirmed";
        attempt.confirmedAt = now;
        this.#locallyPreparedKeys.delete(attempt.key);
      }

      watched.enabled = false;
      if (!this.#isAttemptActive(watched)) {
        watched.status = "needs_attention";
        watched.quotaWait = null;
        watched.attentionCode = "runtime_unavailable";
        watched.attentionReason =
          "本地状态保存失败，自动续跑已关闭；请清理本地数据或重启后重新开启。";
      }
      watched.updatedAt = now;
    }
    this.#emitChanged();
    this.#scheduleWake();
  }

  #emitChanged(): void {
    const snapshot = this.getState();
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        // UI listeners must not break the guardian.
      }
    }
  }

  #scheduleWake(): void {
    if (this.#wakeTimer !== null) {
      clearTimeout(this.#wakeTimer);
      this.#wakeTimer = null;
    }
    if (this.#shuttingDown || this.#clearing || this.#persistenceFailed) {
      return;
    }
    const next = this.#state.watchedThreads
      .filter(
        (thread) =>
          thread.enabled &&
          thread.status === "waiting_quota" &&
          thread.quotaWait !== null,
      )
      .map((thread) => thread.quotaWait?.resumeAfter ?? Number.POSITIVE_INFINITY)
      .sort((left, right) => left - right)[0];
    if (next === undefined || !Number.isFinite(next)) {
      return;
    }
    const delay = Math.max(0, next - this.#now());
    this.#wakeTimer = setTimeout(() => {
      this.#wakeTimer = null;
      void this.checkNow().catch((error: unknown) => this.#reportOperationalError(error));
    }, Math.min(delay, 2_147_483_647));
    this.#wakeTimer.unref();
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    if (this.#wakeTimer !== null) {
      clearTimeout(this.#wakeTimer);
      this.#wakeTimer = null;
    }
    for (const unsubscribe of this.#unsubscribers.splice(0)) {
      unsubscribe();
    }
    if (this.#checkPromise !== null) {
      await this.#checkPromise.catch(() => undefined);
    }
    await this.#persistTail.catch(() => undefined);
  }

  #reportOperationalError(error: unknown): void {
    try {
      this.#onOperationalError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    } catch {
      // Operational diagnostics must never become a second failure path.
    }
  }
}

function clientMessageId(key: string): string {
  return `codex-resume-${createHash("sha256").update(key).digest("hex")}`;
}

function resumeKeyBelongsToThread(key: string, threadId: string): boolean {
  try {
    const value: unknown = JSON.parse(key);
    return Array.isArray(value) && value[0] === threadId;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUsageLimitFailure(turn: ProjectedTurn): boolean {
  return (
    turn.status === "failed" &&
    turn.error !== null &&
    hasUsageLimitError({ type: "turn.failed", error: turn.error })
  );
}

function nonRecoverableQuotaReason(snapshot: QuotaSnapshot): string | null {
  const reachedTypes = new Set(
    [
      snapshot.rateLimitReachedType,
      ...Object.values(snapshot.rateLimitsByLimitId ?? {}).map(
        (limit) => limit.rateLimitReachedType,
      ),
    ].filter((value): value is string => value !== null),
  );
  if ([...reachedTypes].some((value) => value.endsWith("_credits_depleted"))) {
    return "Codex 工作区 credits 已耗尽，无法靠等待刷新自动恢复；请处理额度后重新开启守护。";
  }
  if ([...reachedTypes].some((value) => value.endsWith("_usage_limit_reached"))) {
    return "Codex 工作区用量上限已触发，官方没有提供可等待的刷新窗口；请处理上限后重新开启守护。";
  }
  return null;
}

async function defaultDirectoryExists(cwd: string): Promise<boolean> {
  try {
    return (await stat(cwd)).isDirectory();
  } catch {
    return false;
  }
}
