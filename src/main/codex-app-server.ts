import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { parseQuotaSnapshot } from "../core/quota.js";
import {
  MAX_TASK_OUTPUT_TEXT_LENGTH,
  type QuotaSnapshot,
} from "../shared/types.js";
import { codexChildEnvironment } from "./codex-environment.js";

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CodexAppServerOptions {
  codexPath: string;
  /** Extra argv placed before `app-server`; used by the test fixture. */
  codexArgs?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

export type RateLimitsListener = (snapshot: QuotaSnapshot) => void;

export interface StartTurnInput {
  threadId: string;
  prompt: string;
  /** Correlation id only; App Server does not promise request deduplication. */
  clientUserMessageId: string;
}

export interface ThreadGoalSnapshot {
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
}

export const RESUME_OUTPUT_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["complete", "needs_input", "blocked"],
    },
    message: { type: "string", maxLength: MAX_TASK_OUTPUT_TEXT_LENGTH },
    verification: {
      type: ["string", "null"],
      maxLength: MAX_TASK_OUTPUT_TEXT_LENGTH,
    },
  },
  required: ["status", "message", "verification"],
  additionalProperties: false,
};

export interface TurnCompletedEvent {
  threadId: string;
  turn: JsonObject;
}

export type TurnCompletedListener = (event: TurnCompletedEvent) => void;

export interface ServerRequestEvent {
  id: string | number;
  method: string;
  params: JsonObject | null;
}

export type ServerRequestListener = (event: ServerRequestEvent) => void;

export class CodexAppServerClient {
  readonly #codexPath: string;
  readonly #codexArgs: string[];
  readonly #env: NodeJS.ProcessEnv;
  readonly #requestTimeoutMs: number;
  readonly #listeners = new Set<RateLimitsListener>();
  readonly #turnCompletedListeners = new Set<TurnCompletedListener>();
  readonly #serverRequestListeners = new Set<ServerRequestListener>();
  readonly #pending = new Map<number, PendingRequest>();

  #child: ChildProcessWithoutNullStreams | null = null;
  #startPromise: Promise<void> | null = null;
  #nextRequestId = 1;
  #closing = false;
  #lastRateLimits: JsonObject | null = null;
  #stderr = "";

  constructor(options: CodexAppServerOptions) {
    this.#codexPath = options.codexPath;
    this.#codexArgs = options.codexArgs ?? [];
    this.#env = options.env ?? codexChildEnvironment(process.env);
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  start(): Promise<void> {
    if (this.#child !== null && this.#startPromise === null) {
      return Promise.resolve();
    }
    if (this.#startPromise !== null) {
      return this.#startPromise;
    }

    this.#closing = false;
    const startPromise = this.#startProcess();
    this.#startPromise = startPromise;
    void startPromise.then(
      () => this.#clearStartPromise(startPromise),
      () => this.#clearStartPromise(startPromise),
    );
    return startPromise;
  }

  async close(): Promise<void> {
    this.#closing = true;
    const child = this.#child;
    if (child === null) {
      return;
    }

    this.#child = null;
    this.#rejectPending(new Error("Codex App Server was closed"));
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1_000);
      timer.unref();
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  async readRateLimits(): Promise<QuotaSnapshot> {
    await this.start();
    const result = await this.#request("account/rateLimits/read");
    if (!isObject(result)) {
      throw new Error("Codex App Server returned an invalid rate-limit response");
    }

    this.#lastRateLimits = cloneObject(result);
    const snapshot = parseQuotaSnapshot(result);
    if (snapshot === null) {
      throw new Error("Codex App Server returned an invalid rate-limit snapshot");
    }
    return snapshot;
  }

  async readThread(threadId: string): Promise<JsonObject> {
    if (threadId.length === 0) {
      throw new TypeError("threadId is required");
    }

    await this.start();
    const result = await this.#request("thread/read", {
      threadId,
      includeTurns: true,
    });
    if (
      !isObject(result) ||
      !isObject(result.thread) ||
      result.thread.id !== threadId ||
      !isObject(result.thread.status) ||
      !Array.isArray(result.thread.turns)
    ) {
      throw new Error("Codex App Server returned an invalid thread response");
    }
    return result.thread;
  }

  /** Rejoins the existing thread without overriding its model or permissions. */
  async resumeThread(threadId: string): Promise<JsonObject> {
    if (threadId.length === 0) {
      throw new TypeError("threadId is required");
    }

    await this.start();
    const result = await this.#request("thread/resume", {
      threadId,
    });
    if (!isObject(result) || !isObject(result.thread)) {
      throw new Error("Codex App Server returned an invalid thread/resume response");
    }
    return result.thread;
  }

  async readThreadGoal(threadId: string): Promise<ThreadGoalSnapshot | null> {
    if (threadId.length === 0) {
      throw new TypeError("threadId is required");
    }

    await this.start();
    const result = await this.#request("thread/goal/get", { threadId });
    if (!isObject(result)) {
      throw new Error("Codex App Server returned an invalid thread goal response");
    }
    if (result.goal === null) {
      return null;
    }
    if (
      !isObject(result.goal) ||
      typeof result.goal.objective !== "string" ||
      !isThreadGoalStatus(result.goal.status)
    ) {
      throw new Error("Codex App Server returned an invalid thread goal");
    }
    return {
      objective: result.goal.objective,
      status: result.goal.status,
    };
  }

  async listHooks(cwds: string[]): Promise<JsonObject> {
    await this.start();
    const result = await this.#request("hooks/list", { cwds });
    if (!isObject(result) || !Array.isArray(result.data)) {
      throw new Error("Codex App Server returned an invalid hooks/list response");
    }
    return cloneObject(result);
  }

  /** Starts a plain text turn while preserving all sticky thread settings. */
  async startTurn(input: StartTurnInput): Promise<JsonObject> {
    if (input.threadId.length === 0 || input.prompt.trim().length === 0) {
      throw new TypeError("threadId and prompt are required");
    }
    if (input.clientUserMessageId.length === 0) {
      throw new TypeError("clientUserMessageId is required");
    }

    await this.start();
    const result = await this.#request("turn/start", {
      threadId: input.threadId,
      clientUserMessageId: input.clientUserMessageId,
      input: [
        {
          type: "text",
          text: input.prompt,
          // Required by the current App Server UserInput schema. Keeping this
          // empty preserves plain text semantics without inventing UI spans.
          text_elements: [],
        },
      ],
      outputSchema: RESUME_OUTPUT_SCHEMA,
    });
    if (
      !isObject(result) ||
      !isObject(result.turn) ||
      typeof result.turn.id !== "string" ||
      (result.turn.status !== "completed" &&
        result.turn.status !== "interrupted" &&
        result.turn.status !== "failed" &&
        result.turn.status !== "inProgress")
    ) {
      throw new Error("Codex App Server returned an invalid turn/start response");
    }
    return result.turn;
  }

  onRateLimits(listener: RateLimitsListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onTurnCompleted(listener: TurnCompletedListener): () => void {
    this.#turnCompletedListeners.add(listener);
    return () => this.#turnCompletedListeners.delete(listener);
  }

  onServerRequest(listener: ServerRequestListener): () => void {
    this.#serverRequestListeners.add(listener);
    return () => this.#serverRequestListeners.delete(listener);
  }

  async #startProcess(): Promise<void> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        this.#codexPath,
        [...this.#codexArgs, "app-server", "--stdio"],
        {
          env: this.#env,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (error) {
      throw normalizeError(error, "Unable to start Codex App Server");
    }

    this.#child = child;
    this.#stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = tail(`${this.#stderr}${chunk}`, 16_384);
    });

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.#handleLine(line));

    child.stdin.once("error", (error) => {
      this.#handleProcessEnd(
        child,
        normalizeError(error, "Codex App Server input failed"),
      );
    });
    child.once("error", (error) => {
      this.#handleProcessEnd(child, normalizeError(error, "Codex App Server failed"));
    });
    child.once("exit", (code, signal) => {
      const suffix = this.#stderr.trim();
      const detail = suffix.length > 0 ? `: ${suffix}` : "";
      const cause = new Error(
        `Codex App Server exited (${signal ?? code ?? "unknown"})${detail}`,
      );
      this.#handleProcessEnd(child, cause);
    });

    try {
      const response = await this.#requestNow("initialize", {
        clientInfo: {
          name: "codex_resume_manager",
          title: "Codex Resume Manager",
          version: "0.3.0",
        },
        capabilities: null,
      });
      if (!isObject(response)) {
        throw new Error("Codex App Server returned an invalid initialize response");
      }
      this.#write({ method: "initialized" });
    } catch (error) {
      await this.#discardFailedChild(child);
      throw error;
    }
  }

  async #request(
    method:
      | "account/rateLimits/read"
      | "hooks/list"
      | "thread/read"
      | "thread/goal/get"
      | "thread/resume"
      | "turn/start",
    params?: JsonObject,
  ): Promise<unknown> {
    return this.#requestNow(method, params);
  }

  #requestNow(method: string, params?: JsonObject): Promise<unknown> {
    const id = this.#nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.#requestTimeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });

      const message: JsonObject = { method, id };
      if (params !== undefined) {
        message.params = params;
      }

      try {
        this.#write(message);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(normalizeError(error, `Unable to send App Server request: ${method}`));
      }
    });
  }

  #write(message: JsonObject): void {
    const child = this.#child;
    if (child === null || child.stdin.destroyed || !child.stdin.writable) {
      throw new Error("Codex App Server is not running");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObject(message)) {
      return;
    }

    if (
      (typeof message.id === "number" || typeof message.id === "string") &&
      typeof message.method === "string"
    ) {
      this.#handleServerRequest(message.id, message.method, message.params);
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) {
        return;
      }
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (isObject(message.error)) {
        pending.reject(new Error(rpcErrorMessage(message.error)));
      } else if (Object.hasOwn(message, "result")) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error("Codex App Server returned an invalid response"));
      }
      return;
    }

    if (message.method === "account/rateLimits/updated" && isObject(message.params)) {
      this.#handleRateLimitsNotification(message.params);
      return;
    }

    if (message.method === "turn/completed" && isObject(message.params)) {
      this.#handleTurnCompletedNotification(message.params);
    }
  }

  #handleRateLimitsNotification(params: JsonObject): void {
    const patch = isObject(params.rateLimits) ? params.rateLimits : null;
    if (patch === null) {
      return;
    }

    const previous =
      this.#lastRateLimits !== null && isObject(this.#lastRateLimits.rateLimits)
        ? this.#lastRateLimits.rateLimits
        : null;
    const rateLimits = mergeRateLimits(previous, patch);
    const next: JsonObject = {
      ...(this.#lastRateLimits ?? {}),
      rateLimits,
    };
    const limitId = typeof rateLimits.limitId === "string" ? rateLimits.limitId : null;
    if (limitId !== null && isObject(next.rateLimitsByLimitId)) {
      next.rateLimitsByLimitId = {
        ...next.rateLimitsByLimitId,
        [limitId]: rateLimits,
      };
    }
    this.#lastRateLimits = next;
    const snapshot = parseQuotaSnapshot(this.#lastRateLimits);
    if (snapshot === null) {
      return;
    }

    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        // A renderer listener must not break the protocol reader.
      }
    }
  }

  #handleTurnCompletedNotification(params: JsonObject): void {
    if (typeof params.threadId !== "string" || !isObject(params.turn)) {
      return;
    }
    const event: TurnCompletedEvent = {
      threadId: params.threadId,
      turn: cloneObject(params.turn),
    };
    for (const listener of this.#turnCompletedListeners) {
      try {
        listener(event);
      } catch {
        // A consumer callback must not break the protocol reader.
      }
    }
  }

  #handleServerRequest(id: string | number, method: string, params: unknown): void {
    const event: ServerRequestEvent = {
      id,
      method,
      params: isObject(params) ? cloneObject(params) : null,
    };
    for (const listener of this.#serverRequestListeners) {
      try {
        listener(event);
      } catch {
        // A consumer callback must not prevent the protocol response.
      }
    }

    // This unattended guardian must never guess an approval decision. Returning
    // an explicit protocol error lets the turn fail visibly instead of hanging
    // forever on a request no UI is present to answer.
    try {
      this.#write({
        id,
        error: {
          code: -32_601,
          message: `Unattended guardian cannot handle server request: ${method}`,
        },
      });
    } catch {
      // Process shutdown will reject any pending client requests separately.
    }
  }

  #handleProcessEnd(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.#child !== child) {
      return;
    }
    this.#child = null;
    if (!this.#closing) {
      this.#rejectPending(error);
    }
  }

  async #discardFailedChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.#child === child) {
      this.#child = null;
      this.#rejectPending(new Error("Codex App Server initialization failed"));
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1_000);
      timer.unref();
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #clearStartPromise(startPromise: Promise<void>): void {
    if (this.#startPromise === startPromise) {
      this.#startPromise = null;
    }
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThreadGoalStatus(value: unknown): value is ThreadGoalSnapshot["status"] {
  return (
    value === "active" ||
    value === "paused" ||
    value === "blocked" ||
    value === "usageLimited" ||
    value === "budgetLimited" ||
    value === "complete"
  );
}

function cloneObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function mergeRateLimits(
  previous: JsonObject | null,
  patch: JsonObject,
): JsonObject {
  const merged: JsonObject = { ...(previous ?? {}), ...patch };
  for (const key of ["primary", "secondary"] as const) {
    if (isObject(previous?.[key]) && isObject(patch[key])) {
      merged[key] = { ...previous[key], ...patch[key] };
    }
  }
  return merged;
}

function rpcErrorMessage(error: JsonObject): string {
  const message = typeof error.message === "string" ? error.message : "Unknown RPC error";
  const code = typeof error.code === "number" ? ` (${error.code})` : "";
  return `Codex App Server error${code}: ${message}`;
}

function normalizeError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function tail(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(value.length - maximum);
}
