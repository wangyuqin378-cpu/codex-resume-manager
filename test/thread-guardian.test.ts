import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ThreadGuardian,
  type ThreadGuardianAppServerPort,
} from "../src/main/thread-guardian.js";
import {
  createEmptyStateV2,
  guardianEventMessage,
  privacySafeAppState,
  upgradeAppStateV2,
  type AppStateV2,
  type LegacyAppStateV1,
  type QuotaSnapshot,
  type TaskOutput,
} from "../src/shared/types.js";

function quota(usedPercent: number, resetsAt: number, capturedAt = 0): QuotaSnapshot {
  return {
    primary: {
      name: "primary",
      usedPercent,
      remainingPercent: 100 - usedPercent,
      windowDurationMins: 300,
      resetsAt,
    },
    secondary: null,
    rateLimitReachedType: usedPercent >= 100 ? "primary" : null,
    capturedAt,
  };
}

function sensitiveState(): AppStateV2 {
  const state = createEmptyStateV2(1_000);
  state.watchedThreads.push({
    threadId: "thread-private",
    cwd: "/private/current-project",
    title: "private task title",
    codexVersion: "codex 1.0",
    enabled: false,
    status: "needs_attention",
    quotaWait: null,
    resumeAttempt: null,
    lastObservedTurnId: "turn-private",
    goalObjective: "private current goal",
    goalStatus: "blocked",
    lastResult: {
      status: "needs_input",
      message: "private result message",
      verification: "private verification evidence",
    },
    controlTurnIds: ["turn-control-private"],
    attentionCode: "needs_input",
    attentionReason: "private error details",
    lastSuccessfulCheckAt: 900,
    registeredAt: 100,
    updatedAt: 900,
  });
  state.completedResumeKeys.push(
    JSON.stringify(["thread-private", "turn-private", 500]),
    JSON.stringify(["thread-other", "turn-other", 600]),
  );
  state.events?.push(
    {
      id: "private-event",
      type: "goal_completed",
      threadId: "thread-private",
      turnId: "turn-private",
      message: "private verification evidence",
      at: 900,
    },
    {
      id: "other-event",
      type: "guarding_enabled",
      threadId: "thread-other",
      turnId: "turn-other",
      message: "other private text",
      at: 901,
    },
  );
  return state;
}

function legacyPrivateTask(): Record<string, unknown> {
  return {
    id: "legacy-private-task",
    goal: "private legacy goal",
    successCriteria: "private acceptance criteria",
    cwd: "/private/legacy-project",
    priority: "normal",
    autoResume: true,
    status: "needs_attention",
    createdAt: 1,
    updatedAt: 2,
    codexPath: "/private/bin/codex",
    codexVersion: "private version",
    threadId: "thread-legacy-private",
    lastTurnId: "turn-legacy-private",
    activePid: null,
    quotaWait: null,
    result: {
      status: "blocked",
      message: "private legacy result",
      verification: "private legacy verification",
    },
    attentionCode: "blocked",
    attentionReason: "private legacy error",
    pendingPrompt: "private pending prompt",
  };
}

function oldV2SensitiveState(): AppStateV2 & { tasks: unknown[] } {
  return {
    ...sensitiveState(),
    tasks: [legacyPrivateTask()],
  };
}

function desktopThread(
  id: string,
  turnId = "turn-1",
  options: {
    quotaFailure?: boolean;
    threadStatus?: "idle" | "active" | "notLoaded";
    turnStatus?: "completed" | "failed" | "inProgress";
    parentThreadId?: string | null;
    output?: TaskOutput | null;
    outputText?: string;
  } = {},
): Record<string, unknown> {
  const quotaFailure = options.quotaFailure ?? false;
  const turnStatus = options.turnStatus ?? (quotaFailure ? "failed" : "completed");
  const output = options.output ?? {
    status: "complete",
    message: "The requested goal is complete.",
    verification: "Guardian fixture verification passed.",
  };
  const hasExplicitNullOutput = Object.hasOwn(options, "output") && options.output === null;
  return {
    id,
    cwd: `/tmp/${id}`,
    name: `Task ${id}`,
    parentThreadId: options.parentThreadId ?? null,
    status:
      options.threadStatus === "active"
        ? { type: "active", activeFlags: [] }
        : { type: options.threadStatus ?? "idle" },
    turns: [
      {
        id: turnId,
        status: turnStatus,
        error: quotaFailure
          ? { message: "quota", codexErrorInfo: "usageLimitExceeded" }
          : null,
        items:
          turnStatus === "completed" && !hasExplicitNullOutput
            ? [
                {
                  type: "agentMessage",
                  text: options.outputText ?? JSON.stringify(output),
                },
              ]
            : [],
      },
    ],
  };
}

class FakeAppServer implements ThreadGuardianAppServerPort {
  quotaSnapshots: QuotaSnapshot[] = [quota(0, 1_000)];
  threads = new Map<string, Record<string, unknown>>();
  goals = new Map<
    string,
    { objective: string; status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete" }
  >();
  threadErrors = new Map<string, Error>();
  rateReads = 0;
  resumeCalls: string[] = [];
  resumeFailure: Error | null = null;
  startCalls: Array<{ threadId: string; prompt: string; clientUserMessageId: string }> = [];
  serverRequestListener: ((event: {
    id: string | number;
    method: string;
    params: Record<string, unknown> | null;
  }) => void) | null = null;
  startFailure: Error | null = null;
  startTurnFailureAfterSideEffect: Error | null = null;
  readCalls = 0;
  readGate: Promise<void> | null = null;
  releaseRead: (() => void) | null = null;
  resumeGate: Promise<void> | null = null;
  releaseResume: (() => void) | null = null;

  async start(): Promise<void> {
    if (this.startFailure !== null) {
      const failure = this.startFailure;
      this.startFailure = null;
      throw failure;
    }
  }

  async readRateLimits(): Promise<QuotaSnapshot> {
    this.rateReads += 1;
    const next = this.quotaSnapshots.length > 1
      ? this.quotaSnapshots.shift()
      : this.quotaSnapshots[0];
    if (next === undefined) {
      throw new Error("missing quota fixture");
    }
    return structuredClone(next);
  }

  async readThread(threadId: string): Promise<Record<string, unknown>> {
    this.readCalls += 1;
    if (this.readGate !== null) {
      const gate = this.readGate;
      await gate;
      if (this.readGate === gate) {
        this.readGate = null;
        this.releaseRead = null;
      }
    }
    const failure = this.threadErrors.get(threadId);
    if (failure !== undefined) {
      throw failure;
    }
    const value = this.threads.get(threadId);
    if (value === undefined) {
      throw new Error(`unknown thread: ${threadId}`);
    }
    return structuredClone(value);
  }

  pauseNextRead(): void {
    this.readGate = new Promise<void>((resolve) => {
      this.releaseRead = resolve;
    });
  }

  async readThreadGoal(threadId: string): Promise<{
    objective: string;
    status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  } | null> {
    return structuredClone(this.goals.get(threadId) ?? null);
  }

  async resumeThread(threadId: string): Promise<Record<string, unknown>> {
    this.resumeCalls.push(threadId);
    if (this.resumeFailure !== null) {
      const failure = this.resumeFailure;
      this.resumeFailure = null;
      throw failure;
    }
    if (this.resumeGate !== null) {
      await this.resumeGate;
      this.resumeGate = null;
      this.releaseResume = null;
    }
    return this.readThread(threadId);
  }

  pauseNextResume(): void {
    this.resumeGate = new Promise<void>((resolve) => {
      this.releaseResume = resolve;
    });
  }

  async startTurn(input: {
    threadId: string;
    prompt: string;
    clientUserMessageId: string;
  }): Promise<Record<string, unknown>> {
    this.startCalls.push(input);
    const current = await this.readThread(input.threadId);
    const turn = {
      id: `turn-resume-${this.startCalls.length}`,
      status: "inProgress",
      error: null,
    };
    this.threads.set(input.threadId, {
      ...current,
      status: { type: "active", activeFlags: [] },
      turns: [...(current.turns as unknown[]), turn],
    });
    if (this.startTurnFailureAfterSideEffect !== null) {
      const failure = this.startTurnFailureAfterSideEffect;
      this.startTurnFailureAfterSideEffect = null;
      throw failure;
    }
    return turn;
  }

  onServerRequest(listener: (event: {
    id: string | number;
    method: string;
    params: Record<string, unknown> | null;
  }) => void): () => void {
    this.serverRequestListener = listener;
    return () => {
      if (this.serverRequestListener === listener) {
        this.serverRequestListener = null;
      }
    };
  }
}

async function harness(options: {
  now?: number;
  initialState?: AppStateV2;
  directoryExists?: (cwd: string) => Promise<boolean>;
  getCodexVersion?: () => Promise<string | null>;
} = {}): Promise<{
  guardian: ThreadGuardian;
  appServer: FakeAppServer;
  directory: string;
  clock: { value: number };
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thread-guardian-"));
  const statePath = path.join(directory, "state.json");
  if (options.initialState !== undefined) {
    await writeFile(statePath, `${JSON.stringify(options.initialState, null, 2)}\n`, "utf8");
  }
  const appServer = new FakeAppServer();
  const clock = { value: options.now ?? 0 };
  const guardian = new ThreadGuardian({
    statePath,
    appServer,
    now: () => clock.value,
    pollIntervalMs: 0,
    directoryExists: options.directoryExists ?? (async () => true),
    getCodexVersion: options.getCodexVersion ?? (async () => "codex 1.0"),
  });
  await guardian.initialize();
  return { guardian, appServer, directory, clock };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for guardian test state");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("privacySafeAppState removes content-bearing fields without mutating memory state", () => {
  const state = oldV2SensitiveState();
  const safe = privacySafeAppState(state);

  assert.equal(state.tasks.length, 1);
  assert.equal(state.watchedThreads[0]?.title, "private task title");
  assert.equal(state.events?.[0]?.message, "private verification evidence");

  assert.equal(Object.hasOwn(safe, "tasks"), false);
  assert.equal(safe.watchedThreads[0]?.title, null);
  assert.equal(safe.watchedThreads[0]?.goalObjective, null);
  assert.equal(safe.watchedThreads[0]?.lastResult, null);
  assert.equal(
    safe.watchedThreads[0]?.attentionReason,
    "任务需要你提供信息后才能继续。",
  );
  assert.equal(safe.events?.[0]?.turnId, null);
  assert.equal(safe.events?.[0]?.message, guardianEventMessage("goal_completed"));
  assert.equal(safe.events?.[1]?.turnId, null);
  assert.equal(safe.events?.[1]?.message, guardianEventMessage("guarding_enabled"));
  const serialized = JSON.stringify(safe);
  for (const secret of [
    "private task title",
    "private current goal",
    "private result message",
    "private verification evidence",
    "private error details",
    "private pending prompt",
    "private legacy goal",
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("legacy manager migration drops prompt-bearing tasks and obsolete resume keys", () => {
  const task = legacyPrivateTask();
  const legacy: LegacyAppStateV1 = {
    version: 1,
    tasks: [task],
    quota: null,
    completedResumeKeys: [
      JSON.stringify(["thread-legacy-private", "turn-legacy-private", 500]),
    ],
    updatedAt: 900,
  };

  const upgraded = upgradeAppStateV2(legacy, 1_000);

  assert.equal(Object.hasOwn(upgraded, "tasks"), false);
  assert.deepEqual(upgraded.completedResumeKeys, []);
  assert.deepEqual(upgraded.watchedThreads, []);
});

test("initialize immediately rewrites old V2 state through the privacy boundary", async (t) => {
  const h = await harness({ initialState: oldV2SensitiveState() });
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });

  const inMemory = h.guardian.getThreadStatus("thread-private");
  assert.equal(inMemory?.title, "private task title");
  assert.equal(inMemory?.goalObjective, "private current goal");
  assert.equal(inMemory?.lastResult?.verification, "private verification evidence");
  assert.equal(Object.hasOwn(h.guardian.getState(), "tasks"), false);

  const persisted = JSON.parse(
    await readFile(path.join(h.directory, "state.json"), "utf8"),
  ) as AppStateV2;
  assert.equal(Object.hasOwn(persisted, "tasks"), false);
  assert.equal(persisted.watchedThreads[0]?.title, null);
  assert.equal(persisted.watchedThreads[0]?.goalObjective, null);
  assert.equal(persisted.watchedThreads[0]?.lastResult, null);
  assert.equal(persisted.events?.[0]?.turnId, null);
  assert.equal(persisted.events?.[0]?.message, guardianEventMessage("goal_completed"));
  const serialized = await readFile(path.join(h.directory, "state.json"), "utf8");
  for (const secret of [
    "private task title",
    "private current goal",
    "private verification evidence",
    "private error details",
    "private pending prompt",
    "private legacy goal",
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("each commit persists a privacy-safe copy while retaining live goal data", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.threads.set("thread-live-private", desktopThread("thread-live-private"));
  h.appServer.goals.set("thread-live-private", {
    objective: "private live goal",
    status: "active",
  });

  await h.guardian.registerThread("thread-live-private");
  assert.equal(
    h.guardian.getThreadStatus("thread-live-private")?.goalObjective,
    "private live goal",
  );

  const persisted = JSON.parse(
    await readFile(path.join(h.directory, "state.json"), "utf8"),
  ) as AppStateV2;
  assert.equal(persisted.watchedThreads[0]?.title, null);
  assert.equal(persisted.watchedThreads[0]?.goalObjective, null);
  assert.equal(persisted.events?.[0]?.turnId, null);
  assert.equal(persisted.events?.[0]?.message, guardianEventMessage("guarding_enabled"));
  assert.doesNotMatch(await readFile(path.join(h.directory, "state.json"), "utf8"), /private live goal/u);
});

test("registers, reports, disables, and re-enables the current Codex thread", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.threads.set("thread-a", desktopThread("thread-a"));

  const registered = await h.guardian.registerThread("thread-a");
  assert.equal(registered.cwd, "/tmp/thread-a");
  assert.equal(registered.title, "Task thread-a");
  assert.equal(registered.status, "watching");
  assert.equal(h.guardian.getThreadStatus("thread-a")?.enabled, true);

  await h.guardian.disableThread("thread-a");
  assert.equal(h.guardian.getThreadStatus("thread-a")?.status, "disabled");
  await h.guardian.enableThread("thread-a");
  assert.equal(h.guardian.getThreadStatus("thread-a")?.status, "watching");
});

test("removing a thread also removes its events and completed resume keys", async (t) => {
  const h = await harness({ initialState: sensitiveState() });
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });

  await h.guardian.removeThread("thread-private");

  const state = h.guardian.getState();
  assert.equal(state.watchedThreads.some((thread) => thread.threadId === "thread-private"), false);
  assert.equal(state.events?.some((event) => event.threadId === "thread-private"), false);
  assert.deepEqual(
    state.completedResumeKeys,
    [JSON.stringify(["thread-other", "turn-other", 600])],
  );
  const persisted = await readFile(path.join(h.directory, "state.json"), "utf8");
  assert.equal(persisted.includes("thread-private"), false);
});

test("clearAllLocalData clears the in-memory and persisted guardian state", async (t) => {
  const h = await harness({ initialState: sensitiveState() });
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });

  await h.guardian.clearAllLocalData();

  assert.deepEqual(h.guardian.getState(), createEmptyStateV2(0));
  const persisted = JSON.parse(
    await readFile(path.join(h.directory, "state.json"), "utf8"),
  ) as AppStateV2;
  assert.deepEqual(persisted, createEmptyStateV2(0));
});

test("clearAllLocalData repairs corrupt state without initializing App Server", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thread-guardian-clear-corrupt-"));
  const statePath = path.join(directory, "state.json");
  await writeFile(statePath, "{ definitely not valid json\n", "utf8");
  const appServer = new FakeAppServer();
  appServer.startFailure = new Error("App Server is offline");
  const guardian = new ThreadGuardian({
    statePath,
    appServer,
    now: () => 123,
    pollIntervalMs: 0,
  });
  t.after(async () => {
    await guardian.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  await guardian.clearAllLocalData();

  assert.deepEqual(guardian.getState(), createEmptyStateV2(123));
  assert.deepEqual(
    JSON.parse(await readFile(statePath, "utf8")),
    createEmptyStateV2(123),
  );
  // startFailure is consumed only if start() was called, so this also proves
  // the privacy reset did not depend on a live App Server.
  assert.equal(appServer.startFailure?.message, "App Server is offline");
});

test("a privacy clear wins over a check paused before resume preparation", async (t) => {
  const h = await harness();
  t.after(async () => {
    h.appServer.releaseRead?.();
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000), quota(0, 1_000, 61_000)];
  h.appServer.threads.set(
    "thread-clear-race",
    desktopThread("thread-clear-race", "failed", { quotaFailure: true }),
  );
  await h.guardian.registerThread("thread-clear-race");
  h.appServer.pauseNextRead();
  const expectedReadCount = h.appServer.readCalls + 1;
  const checking = h.guardian.checkNow();
  await waitFor(() => h.appServer.readCalls >= expectedReadCount);

  await h.guardian.clearAllLocalData();
  h.appServer.releaseRead?.();
  await checking;

  assert.equal(h.appServer.startCalls.length, 0);
  assert.deepEqual(h.guardian.getState(), createEmptyStateV2(0));
  assert.deepEqual(
    JSON.parse(await readFile(path.join(h.directory, "state.json"), "utf8")),
    createEmptyStateV2(0),
  );
});

test("a failed enable commit fails closed and cannot start an automatic turn", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.threads.set(
    "thread-persist-failure",
    desktopThread("thread-persist-failure", "failed", { quotaFailure: true }),
  );
  await h.guardian.registerThread("thread-persist-failure");
  await h.guardian.disableThread("thread-persist-failure");

  const statePath = path.join(h.directory, "state.json");
  await rm(statePath);
  await mkdir(statePath);

  await assert.rejects(
    () => h.guardian.enableThread("thread-persist-failure"),
    /non-regular state file/u,
  );
  const watched = h.guardian.getThreadStatus("thread-persist-failure");
  assert.equal(watched?.enabled, false);
  assert.equal(watched?.status, "needs_attention");
  assert.equal(watched?.attentionCode, "runtime_unavailable");

  await h.guardian.checkNow();
  assert.equal(h.appServer.startCalls.length, 0);
});

test("clearAllLocalData refuses to erase an active automatic resume checkpoint", async (t) => {
  const state = sensitiveState();
  const watched = state.watchedThreads[0];
  assert.ok(watched);
  watched.enabled = true;
  watched.status = "resuming";
  watched.attentionCode = null;
  watched.attentionReason = null;
  watched.resumeAttempt = {
    key: JSON.stringify([watched.threadId, "turn-failed", 500]),
    phase: "started",
    failedTurnId: "turn-failed",
    preparedAt: 500,
    startedAt: 501,
    startedTurnId: "turn-auto",
    confirmedAt: null,
  };
  const h = await harness({ initialState: state });
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });

  await assert.rejects(
    () => h.guardian.clearAllLocalData(),
    /automatic turn is active/u,
  );
  assert.notEqual(h.guardian.getThreadStatus("thread-private"), null);
});

test("captures the Codex goal and carries it into the automatic continuation", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000), quota(0, 1_000, 61_000)];
  h.appServer.threads.set(
    "thread-goal",
    desktopThread("thread-goal", "turn-failed", { quotaFailure: true }),
  );
  h.appServer.goals.set("thread-goal", {
    objective: "Ship the quota-safe MVP",
    status: "active",
  });

  const registered = await h.guardian.registerThread("thread-goal");
  assert.equal(registered.goalObjective, "Ship the quota-safe MVP");
  assert.equal(registered.goalStatus, "active");
  await h.guardian.checkNow();
  h.clock.value = 61_000;
  await h.guardian.checkNow();

  assert.match(h.appServer.startCalls[0]?.prompt ?? "", /Ship the quota-safe MVP/u);
});

test("reloads a non-persisted Codex goal immediately before a resumed turn", async (t) => {
  const state = createEmptyStateV2(60_000);
  state.watchedThreads.push({
    threadId: "thread-reloaded-goal",
    cwd: "/tmp/thread-reloaded-goal",
    title: null,
    codexVersion: "codex 1.0",
    enabled: true,
    status: "waiting_quota",
    quotaWait: {
      failedTurnId: "turn-failed",
      blockedWindows: [quota(100, 1_000).primary!],
      resumeAfter: 61_000,
      attemptCount: 1,
      idempotencyKey: JSON.stringify(["thread-reloaded-goal", "turn-failed", 1_000]),
    },
    resumeAttempt: null,
    lastObservedTurnId: "turn-failed",
    goalObjective: null,
    goalStatus: null,
    lastResult: null,
    controlTurnIds: [],
    attentionCode: null,
    attentionReason: null,
    lastSuccessfulCheckAt: 60_000,
    registeredAt: 0,
    updatedAt: 60_000,
  });
  const h = await harness({ now: 61_000, initialState: state });
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(0, 1_000, 61_000)];
  h.appServer.threads.set(
    "thread-reloaded-goal",
    desktopThread("thread-reloaded-goal", "turn-failed", { quotaFailure: true }),
  );
  h.appServer.goals.set("thread-reloaded-goal", {
    objective: "private goal fetched just in time",
    status: "active",
  });

  await h.guardian.checkNow();

  assert.match(h.appServer.startCalls[0]?.prompt ?? "", /private goal fetched just in time/u);
  const persisted = await readFile(path.join(h.directory, "state.json"), "utf8");
  assert.equal(persisted.includes("private goal fetched just in time"), false);
});

test("creates a wait only for a top-level structured UsageLimitExceeded turn", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000)];
  h.appServer.threads.set("thread-quota", desktopThread("thread-quota", "failed", { quotaFailure: true }));
  h.appServer.threads.set(
    "thread-subagent",
    desktopThread("thread-subagent", "sub-failed", {
      quotaFailure: true,
      parentThreadId: "thread-quota",
    }),
  );
  await h.guardian.registerThread("thread-quota");
  await assert.rejects(() => h.guardian.registerThread("thread-subagent"), /top-level/u);
  await h.guardian.checkNow();

  const watched = h.guardian.getThreadStatus("thread-quota");
  assert.equal(watched?.status, "waiting_quota");
  assert.equal(watched?.quotaWait?.failedTurnId, "failed");
  assert.equal(watched?.quotaWait?.resumeAfter, 61_000);
  assert.equal(h.appServer.startCalls.length, 0);
});

test("does not wait forever for non-recoverable workspace quota types", async (t) => {
  const cleanups: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
  });

  for (const [suffix, reachedType] of [
    ["credits", "workspace_owner_credits_depleted"],
    ["usage", "workspace_member_usage_limit_reached"],
  ] as const) {
    const h = await harness();
    cleanups.push(async () => {
      await h.guardian.shutdown();
      await rm(h.directory, { recursive: true, force: true });
    });
    const threadId = `thread-workspace-${suffix}`;
    h.appServer.quotaSnapshots = [
      {
        primary: null,
        secondary: null,
        rateLimitReachedType: reachedType,
        capturedAt: 0,
      },
    ];
    h.appServer.threads.set(
      threadId,
      desktopThread(threadId, "turn-workspace-limit", { quotaFailure: true }),
    );

    await h.guardian.registerThread(threadId);
    await h.guardian.checkNow();

    const watched = h.guardian.getThreadStatus(threadId);
    assert.equal(watched?.status, "needs_attention");
    assert.equal(watched?.attentionCode, "blocked");
    assert.equal(watched?.enabled, false);
    assert.equal(watched?.quotaWait, null);
    assert.notEqual(watched?.status, "waiting_quota_data");
    assert.equal(h.appServer.startCalls.length, 0);
  }
});

test("after reset, resumes and starts exactly one turn on the same idle thread", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000), quota(0, 1_000, 61_000)];
  h.appServer.threads.set("thread-q", desktopThread("thread-q", "turn-failed", { quotaFailure: true }));
  await h.guardian.registerThread("thread-q");
  await h.guardian.checkNow();

  h.clock.value = 60_999;
  await h.guardian.checkNow();
  assert.equal(h.appServer.startCalls.length, 0);

  h.clock.value = 61_000;
  await h.guardian.checkNow();
  assert.deepEqual(h.appServer.resumeCalls, ["thread-q"]);
  assert.equal(h.appServer.startCalls.length, 1);
  assert.equal(h.appServer.startCalls[0]?.threadId, "thread-q");
  assert.match(h.appServer.startCalls[0]?.prompt ?? "", /不要重复/u);
  assert.equal(h.guardian.getThreadStatus("thread-q")?.resumeAttempt?.phase, "started");

  await h.guardian.checkNow();
  assert.equal(h.appServer.startCalls.length, 1);

  h.appServer.threads.set(
    "thread-q",
    desktopThread("thread-q", "turn-resume-1", { turnStatus: "completed" }),
  );
  await h.guardian.checkNow();
  assert.equal(h.guardian.getThreadStatus("thread-q")?.status, "completed");
  assert.equal(h.guardian.getThreadStatus("thread-q")?.enabled, false);
  assert.equal(h.guardian.getThreadStatus("thread-q")?.goalStatus, "complete");
  assert.deepEqual(h.guardian.getThreadStatus("thread-q")?.lastResult, {
    status: "complete",
    message: "The requested goal is complete.",
    verification: "Guardian fixture verification passed.",
  });
  assert.equal(h.guardian.getThreadStatus("thread-q")?.quotaWait, null);
  assert.equal(h.guardian.getState().completedResumeKeys.length, 1);
  const goalEvent = h.guardian.getState().events?.find((event) => event.type === "goal_completed");
  assert.equal(goalEvent?.message, guardianEventMessage("goal_completed"));
  assert.equal(goalEvent?.message.includes("Guardian fixture verification passed"), false);
  const persisted = JSON.parse(
    await readFile(path.join(h.directory, "state.json"), "utf8"),
  ) as AppStateV2;
  assert.equal(persisted.watchedThreads[0]?.lastResult, null);
  assert.equal(
    persisted.events?.every(
      (event) => event.turnId === null && event.message === guardianEventMessage(event.type),
    ),
    true,
  );
});

test("routes structured needs_input and blocked results to explicit human attention", async (t) => {
  const cleanups: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
  });

  for (const status of ["needs_input", "blocked"] as const) {
    const h = await harness();
    cleanups.push(async () => {
      await h.guardian.shutdown();
      await rm(h.directory, { recursive: true, force: true });
    });
    const threadId = `thread-${status}`;
    h.appServer.quotaSnapshots = [quota(100, 1_000), quota(0, 1_000, 61_000)];
    h.appServer.threads.set(
      threadId,
      desktopThread(threadId, "turn-failed", { quotaFailure: true }),
    );
    await h.guardian.registerThread(threadId);
    await h.guardian.checkNow();
    h.clock.value = 61_000;
    await h.guardian.checkNow();
    h.appServer.threads.set(
      threadId,
      desktopThread(threadId, "turn-resume-1", {
        output: {
          status,
          message: status === "needs_input" ? "Choose a release channel." : "Deployment access is unavailable.",
          verification: null,
        },
      }),
    );
    await h.guardian.checkNow();

    const watched = h.guardian.getThreadStatus(threadId);
    assert.equal(watched?.status, "needs_attention");
    assert.equal(watched?.enabled, false);
    assert.equal(watched?.attentionCode, status);
    assert.equal(watched?.lastResult?.status, status);
  }
});

test("fails closed when a completed automatic turn omits the exact result schema", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000), quota(0, 1_000, 61_000)];
  h.appServer.threads.set(
    "thread-invalid-output",
    desktopThread("thread-invalid-output", "turn-failed", { quotaFailure: true }),
  );
  await h.guardian.registerThread("thread-invalid-output");
  await h.guardian.checkNow();
  h.clock.value = 61_000;
  await h.guardian.checkNow();
  h.appServer.threads.set(
    "thread-invalid-output",
    desktopThread("thread-invalid-output", "turn-resume-1", {
      outputText: '{"status":"complete","message":"done"}',
    }),
  );
  await h.guardian.checkNow();

  const watched = h.guardian.getThreadStatus("thread-invalid-output");
  assert.equal(watched?.status, "needs_attention");
  assert.equal(watched?.enabled, false);
  assert.equal(watched?.attentionCode, "invalid_output");
  assert.equal(watched?.lastResult, null);
});

test("keeps needs_attention after an unattended server request finishes the turn", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000), quota(0, 1_000, 61_000)];
  h.appServer.threads.set("thread-approval", desktopThread("thread-approval", "failed", { quotaFailure: true }));
  await h.guardian.registerThread("thread-approval");
  await h.guardian.checkNow();
  h.clock.value = 61_000;
  await h.guardian.checkNow();

  h.appServer.serverRequestListener?.({
    id: "approval-1",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-approval" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  h.appServer.threads.set(
    "thread-approval",
    desktopThread("thread-approval", "turn-resume-1", { turnStatus: "failed" }),
  );
  await h.guardian.checkNow();

  const watched = h.guardian.getThreadStatus("thread-approval");
  assert.equal(watched?.status, "needs_attention");
  assert.equal(watched?.enabled, false);
  assert.match(watched?.attentionReason ?? "", /人工/u);
});

test("manual continuation cancels automatic resume and asks for review", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000), quota(0, 1_000, 61_000)];
  h.appServer.threads.set("thread-manual", desktopThread("thread-manual", "turn-failed", { quotaFailure: true }));
  await h.guardian.registerThread("thread-manual");
  await h.guardian.checkNow();
  h.appServer.threads.set("thread-manual", desktopThread("thread-manual", "turn-user", { turnStatus: "completed" }));
  h.clock.value = 61_000;
  await h.guardian.checkNow();

  assert.equal(h.appServer.startCalls.length, 0);
  assert.equal(h.guardian.getThreadStatus("thread-manual")?.status, "needs_attention");
  assert.equal(h.guardian.getThreadStatus("thread-manual")?.enabled, false);
  assert.match(
    h.guardian.getThreadStatus("thread-manual")?.attentionReason ?? "",
    /external|外部|手动/u,
  );
});

test("authorized control turns do not mask later external work", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  const threadId = "thread-control-tail";
  const initialThread = desktopThread(threadId);
  initialThread.turns = [
    {
      id: "turn-quota-failed",
      status: "failed",
      error: { message: "quota", codexErrorInfo: "usageLimitExceeded" },
      items: [],
    },
    {
      id: "turn-control-enable",
      status: "completed",
      error: null,
      items: [],
    },
  ];
  h.appServer.threads.set(threadId, initialThread);
  h.appServer.quotaSnapshots = [quota(100, 1_000), quota(0, 1_000, 61_000)];

  const registered = await h.guardian.registerThread(
    threadId,
    "turn-control-enable",
  );
  assert.deepEqual(registered.controlTurnIds, ["turn-control-enable"]);
  await h.guardian.checkNow();
  assert.equal(h.guardian.getThreadStatus(threadId)?.status, "waiting_quota");
  assert.equal(
    h.guardian.getThreadStatus(threadId)?.quotaWait?.failedTurnId,
    "turn-quota-failed",
  );

  h.clock.value = 61_000;
  await h.guardian.checkNow();
  assert.equal(h.appServer.startCalls.length, 1);
  assert.equal(h.guardian.getThreadStatus(threadId)?.status, "resuming");

  const afterStart = h.appServer.threads.get(threadId);
  assert.ok(afterStart);
  h.appServer.threads.set(threadId, {
    ...afterStart,
    status: { type: "idle" },
    turns: [
      ...(afterStart.turns as unknown[]),
      {
        id: "turn-unapproved-user-work",
        status: "completed",
        error: null,
        items: [],
      },
    ],
  });
  await h.guardian.checkNow();

  const watched = h.guardian.getThreadStatus(threadId);
  assert.equal(h.appServer.startCalls.length, 1);
  assert.equal(watched?.status, "needs_attention");
  assert.equal(watched?.attentionCode, "external_activity");
  assert.equal(watched?.enabled, false);
});

test("a trailing authorized status turn preserves the completed automatic result", async (t) => {
  const cleanups: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
  });

  for (const authorized of [true, false]) {
    const h = await harness();
    cleanups.push(async () => {
      await h.guardian.shutdown();
      await rm(h.directory, { recursive: true, force: true });
    });
    const threadId = authorized
      ? "thread-complete-then-status"
      : "thread-complete-then-external";
    const tailTurnId = authorized
      ? "turn-authorized-status"
      : "turn-unapproved-tail";
    h.appServer.quotaSnapshots = [quota(100, 1_000), quota(0, 1_000, 61_000)];
    h.appServer.threads.set(
      threadId,
      desktopThread(threadId, "turn-quota", { quotaFailure: true }),
    );
    await h.guardian.registerThread(threadId);
    await h.guardian.checkNow();
    h.clock.value = 61_000;
    await h.guardian.checkNow();
    assert.equal(h.appServer.startCalls.length, 1);

    const afterStart = h.appServer.threads.get(threadId);
    assert.ok(afterStart);
    const turns = (afterStart.turns as Array<Record<string, unknown>>).map((turn) =>
      turn.id === "turn-resume-1"
        ? {
            ...turn,
            status: "completed",
            items: [
              {
                type: "agentMessage",
                text: JSON.stringify({
                  status: "complete",
                  message: "Automatic continuation completed the goal.",
                  verification: "All acceptance checks passed.",
                }),
              },
            ],
          }
        : turn,
    );
    h.appServer.threads.set(threadId, {
      ...afterStart,
      status: { type: "idle" },
      turns: [
        ...turns,
        {
          id: tailTurnId,
          status: "completed",
          error: null,
          items: [],
        },
      ],
    });
    if (authorized) {
      await h.guardian.noteControlTurn(threadId, tailTurnId);
      assert.deepEqual(
        h.guardian.getThreadStatus(threadId)?.controlTurnIds,
        [tailTurnId],
      );
    }

    await h.guardian.checkNow();
    const watched = h.guardian.getThreadStatus(threadId);
    assert.equal(h.appServer.startCalls.length, 1);
    if (authorized) {
      assert.equal(watched?.status, "completed");
      assert.equal(watched?.enabled, false);
      assert.deepEqual(watched?.lastResult, {
        status: "complete",
        message: "Automatic continuation completed the goal.",
        verification: "All acceptance checks passed.",
      });
      assert.equal(h.guardian.getState().completedResumeKeys.length, 1);
    } else {
      assert.equal(watched?.status, "needs_attention");
      assert.equal(watched?.attentionCode, "external_activity");
      assert.equal(watched?.enabled, false);
    }
  }
});

test("does not resume until the thread is idle", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000), quota(0, 1_000, 61_000)];
  h.appServer.threads.set(
    "thread-active",
    desktopThread("thread-active", "turn-failed", {
      quotaFailure: true,
      threadStatus: "active",
    }),
  );
  await h.guardian.registerThread("thread-active");
  await h.guardian.checkNow();
  h.clock.value = 61_000;
  await h.guardian.checkNow();
  assert.equal(h.appServer.startCalls.length, 0);
});

test("allows a persisted notLoaded thread to be resumed after the reset", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000), quota(0, 1_000, 61_000)];
  h.appServer.threads.set(
    "thread-disk",
    desktopThread("thread-disk", "turn-failed", {
      quotaFailure: true,
      threadStatus: "notLoaded",
    }),
  );
  await h.guardian.registerThread("thread-disk");
  await h.guardian.checkNow();
  h.clock.value = 61_000;
  await h.guardian.checkNow();
  assert.equal(h.appServer.startCalls.length, 1);
});

test("a prepared crash checkpoint never duplicates a turn that already appeared", async (t) => {
  const state = createEmptyStateV2(0);
  state.watchedThreads.push({
    threadId: "thread-crash",
    cwd: "/tmp/thread-crash",
    title: "Crash",
    codexVersion: "codex 1.0",
    enabled: true,
    status: "resuming",
    quotaWait: {
      failedTurnId: "turn-failed",
      blockedWindows: [quota(100, 1_000).primary!],
      resumeAfter: 61_000,
      attemptCount: 1,
      idempotencyKey: JSON.stringify(["thread-crash", "turn-failed", 1_000]),
    },
    resumeAttempt: {
      key: JSON.stringify(["thread-crash", "turn-failed", 1_000]),
      phase: "prepared",
      failedTurnId: "turn-failed",
      preparedAt: 61_000,
      startedAt: null,
      startedTurnId: null,
      confirmedAt: null,
    },
    lastObservedTurnId: "turn-failed",
    attentionReason: null,
    registeredAt: 0,
    updatedAt: 61_000,
  });
  const h = await harness({ now: 62_000, initialState: state });
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(0, 1_000, 62_000)];
  h.appServer.threads.set("thread-crash", desktopThread("thread-crash", "turn-already-started", { turnStatus: "completed" }));
  await h.guardian.checkNow();

  assert.equal(h.appServer.startCalls.length, 0);
  assert.equal(h.guardian.getThreadStatus("thread-crash")?.resumeAttempt?.phase, "confirmed");
  assert.equal(h.guardian.getThreadStatus("thread-crash")?.status, "needs_attention");
  assert.equal(h.guardian.getState().completedResumeKeys.length, 0);
});

test("a prepared crash checkpoint stays active when the failed turn is unchanged", async (t) => {
  const state = createEmptyStateV2(0);
  state.watchedThreads.push({
    threadId: "thread-ambiguous",
    cwd: "/tmp/thread-ambiguous",
    title: "Ambiguous",
    codexVersion: "codex 1.0",
    enabled: true,
    status: "resuming",
    quotaWait: {
      failedTurnId: "turn-failed",
      blockedWindows: [quota(100, 1_000).primary!],
      resumeAfter: 61_000,
      attemptCount: 1,
      idempotencyKey: JSON.stringify(["thread-ambiguous", "turn-failed", 1_000]),
    },
    resumeAttempt: {
      key: JSON.stringify(["thread-ambiguous", "turn-failed", 1_000]),
      phase: "prepared",
      failedTurnId: "turn-failed",
      preparedAt: 61_000,
      startedAt: null,
      startedTurnId: null,
      confirmedAt: null,
    },
    lastObservedTurnId: "turn-failed",
    attentionReason: null,
    registeredAt: 0,
    updatedAt: 61_000,
  });
  const h = await harness({ now: 62_000, initialState: state });
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.threads.set(
    "thread-ambiguous",
    desktopThread("thread-ambiguous", "turn-failed", { quotaFailure: true }),
  );
  await h.guardian.checkNow();

  assert.equal(h.appServer.startCalls.length, 0);
  assert.equal(h.guardian.getThreadStatus("thread-ambiguous")?.status, "needs_attention");
  assert.equal(h.guardian.getThreadStatus("thread-ambiguous")?.enabled, false);
  assert.equal(
    h.guardian.getThreadStatus("thread-ambiguous")?.resumeAttempt?.phase,
    "prepared",
  );
});

test("an ambiguous start side effect blocks every other turn until it is terminal", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000), quota(0, 1_000, 61_000)];
  h.appServer.threads.set(
    "thread-ambiguous-first",
    desktopThread("thread-ambiguous-first", "failed-first", { quotaFailure: true }),
  );
  h.appServer.threads.set(
    "thread-due-second",
    desktopThread("thread-due-second", "failed-second", { quotaFailure: true }),
  );
  await h.guardian.registerThread("thread-ambiguous-first");
  await h.guardian.registerThread("thread-due-second");
  await h.guardian.checkNow();

  h.appServer.startTurnFailureAfterSideEffect = new Error("connection dropped after accept");
  h.clock.value = 61_000;
  await h.guardian.checkNow();

  assert.deepEqual(
    h.appServer.startCalls.map((call) => call.threadId),
    ["thread-ambiguous-first"],
  );
  assert.equal(
    h.guardian.getThreadStatus("thread-ambiguous-first")?.resumeAttempt?.phase,
    "prepared",
  );
  assert.equal(
    h.guardian.getThreadStatus("thread-ambiguous-first")?.status,
    "needs_attention",
  );

  // thread/read now proves that a possible continuation turn exists and is
  // still running. It becomes an observed started checkpoint, but is never
  // submitted again and the second due task remains blocked.
  await h.guardian.checkNow();
  assert.equal(
    h.guardian.getThreadStatus("thread-ambiguous-first")?.resumeAttempt?.phase,
    "started",
  );
  assert.deepEqual(
    h.appServer.startCalls.map((call) => call.threadId),
    ["thread-ambiguous-first"],
  );

  const firstThread = h.appServer.threads.get("thread-ambiguous-first");
  assert.ok(firstThread);
  h.appServer.threads.set("thread-ambiguous-first", {
    ...firstThread,
    status: { type: "idle" },
    turns: (firstThread.turns as Array<Record<string, unknown>>).map((turn) =>
      turn.id === "turn-resume-1"
        ? {
            ...turn,
            status: "completed",
            items: [
              {
                type: "agentMessage",
                text: JSON.stringify({
                  status: "complete",
                  message: "Ambiguous continuation finished.",
                  verification: "Observed terminal state.",
                }),
              },
            ],
          }
        : turn,
    ),
  });

  await h.guardian.checkNow();
  assert.equal(
    h.guardian.getThreadStatus("thread-ambiguous-first")?.resumeAttempt?.phase,
    "confirmed",
  );
  assert.equal(
    h.guardian.getThreadStatus("thread-ambiguous-first")?.status,
    "needs_attention",
  );
  assert.deepEqual(
    h.appServer.startCalls.map((call) => call.threadId),
    ["thread-ambiguous-first", "thread-due-second"],
  );
});

test("a pre-start resume failure releases the queue without retrying that task", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000), quota(0, 1_000, 61_000)];
  h.appServer.threads.set(
    "thread-resume-fails",
    desktopThread("thread-resume-fails", "failed-first", { quotaFailure: true }),
  );
  h.appServer.threads.set(
    "thread-after-resume-failure",
    desktopThread("thread-after-resume-failure", "failed-second", { quotaFailure: true }),
  );
  await h.guardian.registerThread("thread-resume-fails");
  h.clock.value = 1;
  await h.guardian.registerThread("thread-after-resume-failure");
  await h.guardian.checkNow();

  h.appServer.resumeFailure = new Error("resume transport failed before turn/start");
  h.clock.value = 61_000;
  await h.guardian.checkNow();

  const failed = h.guardian.getThreadStatus("thread-resume-fails");
  assert.equal(failed?.status, "needs_attention");
  assert.equal(failed?.enabled, false);
  assert.equal(failed?.resumeAttempt?.phase, "confirmed");
  assert.equal(h.appServer.startCalls.length, 0);

  await h.guardian.checkNow();
  assert.deepEqual(
    h.appServer.startCalls.map((call) => call.threadId),
    ["thread-after-resume-failure"],
  );
  assert.deepEqual(h.appServer.resumeCalls, [
    "thread-resume-fails",
    "thread-after-resume-failure",
  ]);
});

test("disabling during a prepared start preserves the crash checkpoint", async (t) => {
  const state = createEmptyStateV2(0);
  state.watchedThreads.push({
    threadId: "thread-disabling",
    cwd: "/tmp/thread-disabling",
    title: "Disabling",
    codexVersion: "codex 1.0",
    enabled: true,
    status: "resuming",
    quotaWait: {
      failedTurnId: "turn-failed",
      blockedWindows: [quota(100, 1_000).primary!],
      resumeAfter: 61_000,
      attemptCount: 1,
      idempotencyKey: JSON.stringify(["thread-disabling", "turn-failed", 1_000]),
    },
    resumeAttempt: {
      key: JSON.stringify(["thread-disabling", "turn-failed", 1_000]),
      phase: "prepared",
      failedTurnId: "turn-failed",
      preparedAt: 61_000,
      startedAt: null,
      startedTurnId: null,
      confirmedAt: null,
    },
    lastObservedTurnId: "turn-failed",
    attentionReason: null,
    registeredAt: 0,
    updatedAt: 61_000,
  });
  const h = await harness({ now: 61_001, initialState: state });
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });

  await h.guardian.disableThread("thread-disabling");
  const watched = h.guardian.getThreadStatus("thread-disabling");
  assert.equal(watched?.enabled, false);
  assert.equal(watched?.resumeAttempt?.phase, "prepared");
  await assert.rejects(
    () => h.guardian.removeThread("thread-disabling"),
    /automatic turn is active/u,
  );
});

test("globally serializes automatic turns across watched threads", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000), quota(0, 1_000, 61_000)];
  h.appServer.threads.set("thread-a", desktopThread("thread-a", "failed-a", { quotaFailure: true }));
  h.appServer.threads.set("thread-b", desktopThread("thread-b", "failed-b", { quotaFailure: true }));
  await h.guardian.registerThread("thread-a");
  await h.guardian.registerThread("thread-b");
  await h.guardian.checkNow();
  h.clock.value = 61_000;
  await h.guardian.checkNow();
  assert.equal(h.appServer.startCalls.length, 1);

  const first = h.appServer.startCalls[0]?.threadId as string;
  const firstStartedTurnId = h.guardian.getThreadStatus(first)?.resumeAttempt?.startedTurnId;
  assert.ok(firstStartedTurnId);
  h.appServer.threads.set(
    first,
    desktopThread(first, firstStartedTurnId, { turnStatus: "completed" }),
  );
  await h.guardian.checkNow();
  assert.equal(h.appServer.startCalls.length, 2);
  assert.notEqual(h.appServer.startCalls[1]?.threadId, first);
});

test("reschedules when the quota window is still blocked at the old wake time", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000), quota(100, 2_000, 61_000)];
  h.appServer.threads.set("thread-still-blocked", desktopThread("thread-still-blocked", "failed", { quotaFailure: true }));
  await h.guardian.registerThread("thread-still-blocked");
  await h.guardian.checkNow();
  h.clock.value = 61_000;
  await h.guardian.checkNow();

  assert.equal(h.appServer.startCalls.length, 0);
  assert.equal(
    h.guardian.getThreadStatus("thread-still-blocked")?.quotaWait?.resumeAfter,
    62_000,
  );
});

test("requeues with a new wait when the automatic turn hits quota again", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [
    quota(100, 1_000),
    quota(0, 1_000, 61_000),
    quota(100, 3_000, 61_100),
  ];
  h.appServer.threads.set("thread-twice", desktopThread("thread-twice", "failed-1", { quotaFailure: true }));
  await h.guardian.registerThread("thread-twice");
  await h.guardian.checkNow();
  h.clock.value = 61_000;
  await h.guardian.checkNow();
  h.appServer.threads.set("thread-twice", desktopThread("thread-twice", "turn-resume-1", { quotaFailure: true }));
  h.clock.value = 61_100;
  await h.guardian.checkNow();

  const watched = h.guardian.getThreadStatus("thread-twice");
  assert.equal(watched?.status, "waiting_quota");
  assert.equal(watched?.quotaWait?.failedTurnId, "turn-resume-1");
  assert.equal(watched?.quotaWait?.resumeAfter, 63_000);
  assert.equal(h.guardian.getState().completedResumeKeys.length, 1);
});

test("fails closed for a non-quota automatic terminal or a mismatched latest turn", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000), quota(0, 1_000, 61_000)];
  h.appServer.threads.set("thread-fail", desktopThread("thread-fail", "failed", { quotaFailure: true }));
  await h.guardian.registerThread("thread-fail");
  await h.guardian.checkNow();
  h.clock.value = 61_000;
  await h.guardian.checkNow();
  h.appServer.threads.set("thread-fail", desktopThread("thread-fail", "turn-resume-1", { turnStatus: "failed" }));
  await h.guardian.checkNow();
  assert.equal(h.guardian.getThreadStatus("thread-fail")?.status, "needs_attention");

  await h.guardian.enableThread("thread-fail");
  h.appServer.quotaSnapshots = [quota(100, 2_000), quota(0, 2_000, 62_000)];
  h.appServer.threads.set("thread-fail", desktopThread("thread-fail", "failed-2", { quotaFailure: true }));
  await h.guardian.checkNow();
  h.clock.value = 62_000;
  await h.guardian.checkNow();
  h.appServer.threads.set("thread-fail", desktopThread("thread-fail", "external-turn", { turnStatus: "completed" }));
  await h.guardian.checkNow();
  assert.equal(h.guardian.getThreadStatus("thread-fail")?.status, "needs_attention");
  assert.equal(
    h.guardian.getThreadStatus("thread-fail")?.resumeAttempt?.phase,
    "started",
  );
  assert.match(h.guardian.getThreadStatus("thread-fail")?.attentionReason ?? "", /继续观察/u);
});

test("pauses safely when the watched project directory disappeared", async (t) => {
  const h = await harness({ directoryExists: async () => false });
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000)];
  h.appServer.threads.set("thread-missing", desktopThread("thread-missing", "failed", { quotaFailure: true }));
  await h.guardian.registerThread("thread-missing");
  await h.guardian.checkNow();
  h.clock.value = 61_000;
  await h.guardian.checkNow();

  assert.equal(h.appServer.startCalls.length, 0);
  assert.equal(h.guardian.getThreadStatus("thread-missing")?.status, "needs_attention");
  assert.match(h.guardian.getThreadStatus("thread-missing")?.attentionReason ?? "", /文件夹/u);
});

test("requires revalidation when Codex changed since guarding was enabled", async (t) => {
  const versions = ["codex 1.0", "codex 2.0"];
  const h = await harness({
    getCodexVersion: async () => versions.shift() ?? "codex 2.0",
  });
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000)];
  h.appServer.threads.set("thread-version", desktopThread("thread-version", "failed", { quotaFailure: true }));
  await h.guardian.registerThread("thread-version");
  await h.guardian.checkNow();
  h.clock.value = 61_000;
  await h.guardian.checkNow();

  assert.equal(h.appServer.startCalls.length, 0);
  assert.equal(h.guardian.getThreadStatus("thread-version")?.status, "needs_attention");
  assert.match(h.guardian.getThreadStatus("thread-version")?.attentionReason ?? "", /Codex 已从/u);
});

test("a transient unreadable thread retries without starving the next watched thread", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000)];
  h.appServer.threads.set("thread-a", desktopThread("thread-a"));
  h.appServer.threads.set(
    "thread-b",
    desktopThread("thread-b", "failed-b", { quotaFailure: true }),
  );
  await h.guardian.registerThread("thread-a");
  await h.guardian.registerThread("thread-b");
  h.appServer.threadErrors.set("thread-a", new Error("thread was archived"));

  await h.guardian.checkNow();

  assert.equal(h.guardian.getThreadStatus("thread-a")?.status, "watching");
  assert.equal(h.guardian.getThreadStatus("thread-a")?.enabled, true);
  assert.equal(h.guardian.getThreadStatus("thread-b")?.status, "waiting_quota");
  assert.equal(h.guardian.getThreadStatus("thread-b")?.quotaWait?.failedTurnId, "failed-b");

  h.appServer.threadErrors.delete("thread-a");
  await h.guardian.checkNow();
  assert.equal(h.guardian.getThreadStatus("thread-a")?.status, "watching");
  assert.equal(h.guardian.getThreadStatus("thread-a")?.attentionReason, null);
});

test("disable wins while thread/resume is in flight", async (t) => {
  const h = await harness();
  t.after(async () => {
    h.appServer.releaseResume?.();
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000), quota(0, 1_000, 61_000)];
  h.appServer.threads.set("thread-disable-race", desktopThread("thread-disable-race", "failed", { quotaFailure: true }));
  await h.guardian.registerThread("thread-disable-race");
  await h.guardian.checkNow();
  h.appServer.pauseNextResume();
  h.clock.value = 61_000;
  const checking = h.guardian.checkNow();
  await waitFor(() => h.appServer.resumeCalls.length === 1);
  await h.guardian.disableThread("thread-disable-race");
  h.appServer.releaseResume?.();
  await checking;

  assert.equal(h.appServer.startCalls.length, 0);
  assert.equal(h.guardian.getThreadStatus("thread-disable-race")?.status, "disabled");
});

test("remove wins while thread/resume is in flight", async (t) => {
  const h = await harness();
  t.after(async () => {
    h.appServer.releaseResume?.();
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000), quota(0, 1_000, 61_000)];
  h.appServer.threads.set("thread-remove-race", desktopThread("thread-remove-race", "failed", { quotaFailure: true }));
  await h.guardian.registerThread("thread-remove-race");
  await h.guardian.checkNow();
  h.appServer.pauseNextResume();
  h.clock.value = 61_000;
  const checking = h.guardian.checkNow();
  await waitFor(() => h.appServer.resumeCalls.length === 1);
  await h.guardian.removeThread("thread-remove-race");
  h.appServer.releaseResume?.();
  await checking;

  assert.equal(h.appServer.startCalls.length, 0);
  assert.equal(h.guardian.getThreadStatus("thread-remove-race"), null);
});

test("shutdown wins while thread/resume is in flight", async (t) => {
  const h = await harness();
  t.after(async () => {
    h.appServer.releaseResume?.();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.quotaSnapshots = [quota(100, 1_000), quota(0, 1_000, 61_000)];
  h.appServer.threads.set("thread-shutdown-race", desktopThread("thread-shutdown-race", "failed", { quotaFailure: true }));
  await h.guardian.registerThread("thread-shutdown-race");
  await h.guardian.checkNow();
  h.appServer.pauseNextResume();
  h.clock.value = 61_000;
  const checking = h.guardian.checkNow();
  await waitFor(() => h.appServer.resumeCalls.length === 1);
  const shuttingDown = h.guardian.shutdown();
  h.appServer.releaseResume?.();
  await Promise.all([checking, shuttingDown]);

  assert.equal(h.appServer.startCalls.length, 0);
});

test("recovers a persisted started checkpoint without sending a second turn", async (t) => {
  const state = createEmptyStateV2(0);
  state.watchedThreads.push({
    threadId: "thread-started-crash",
    cwd: "/tmp/thread-started-crash",
    title: "Started crash",
    codexVersion: "codex 1.0",
    enabled: true,
    status: "resuming",
    quotaWait: {
      failedTurnId: "failed",
      blockedWindows: [quota(100, 1_000).primary!],
      resumeAfter: 61_000,
      attemptCount: 1,
      idempotencyKey: JSON.stringify(["thread-started-crash", "failed", 1_000]),
    },
    resumeAttempt: {
      key: JSON.stringify(["thread-started-crash", "failed", 1_000]),
      phase: "started",
      failedTurnId: "failed",
      preparedAt: 61_000,
      startedAt: 61_001,
      startedTurnId: "turn-auto",
      confirmedAt: null,
    },
    lastObservedTurnId: "turn-auto",
    attentionReason: null,
    registeredAt: 0,
    updatedAt: 61_001,
  });
  const h = await harness({ now: 61_100, initialState: state });
  t.after(async () => {
    await h.guardian.shutdown();
    await rm(h.directory, { recursive: true, force: true });
  });
  h.appServer.threads.set(
    "thread-started-crash",
    desktopThread("thread-started-crash", "turn-auto", {
      threadStatus: "active",
      turnStatus: "inProgress",
    }),
  );
  await h.guardian.checkNow();
  assert.equal(h.appServer.startCalls.length, 0);
  assert.equal(h.guardian.getThreadStatus("thread-started-crash")?.resumeAttempt?.phase, "started");

  h.appServer.threads.set(
    "thread-started-crash",
    desktopThread("thread-started-crash", "turn-auto", { turnStatus: "completed" }),
  );
  await h.guardian.checkNow();
  assert.equal(h.appServer.startCalls.length, 0);
  assert.equal(h.guardian.getThreadStatus("thread-started-crash")?.resumeAttempt?.phase, "confirmed");
  assert.equal(h.guardian.getThreadStatus("thread-started-crash")?.status, "completed");
});

test("initialize failure can be retried without a poisoned promise", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thread-guardian-init-"));
  const statePath = path.join(directory, "state.json");
  await writeFile(statePath, `${JSON.stringify(oldV2SensitiveState(), null, 2)}\n`, "utf8");
  const appServer = new FakeAppServer();
  appServer.startFailure = new Error("temporary startup failure");
  const guardian = new ThreadGuardian({
    statePath,
    appServer,
    pollIntervalMs: 0,
    directoryExists: async () => true,
    getCodexVersion: async () => "codex 1.0",
  });
  t.after(async () => {
    await guardian.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  await assert.rejects(() => guardian.initialize(), /temporary startup failure/u);
  const afterFailedStart = JSON.parse(await readFile(statePath, "utf8")) as AppStateV2;
  assert.equal(Object.hasOwn(afterFailedStart, "tasks"), false);
  assert.equal(afterFailedStart.watchedThreads[0]?.title, null);
  assert.equal(afterFailedStart.watchedThreads[0]?.goalObjective, null);
  assert.equal(afterFailedStart.watchedThreads[0]?.lastResult, null);
  assert.equal(afterFailedStart.events?.[0]?.turnId, null);
  await guardian.initialize();
  assert.equal(guardian.getState().version, 2);
});
