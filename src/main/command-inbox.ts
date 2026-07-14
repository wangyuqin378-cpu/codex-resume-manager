import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

const MAX_COMMAND_FILE_BYTES = 64 * 1024;
const COMMAND_TTL_MS = 5 * 60_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 60_000;

export type GuardianCommandAction = "enable" | "disable" | "status";

export interface GuardianCommand {
  id: string;
  action: GuardianCommandAction;
  threadId: string;
  turnId: string | null;
  createdAt: number;
}

export interface CommandInboxOptions {
  directory: string;
  pollIntervalMs?: number;
  maxAttempts?: number;
  now?: () => number;
  onInvalid?: (fileName: string, reason: string) => void;
  onFailure?: (failure: CommandInboxFailure) => void;
}

export interface CommandInboxFailure {
  phase: "recovery" | "drain" | "read" | "listener";
  fileName: string | null;
  reason: string;
  attempt: number | null;
  willRetry: boolean;
  deadLetterPath: string | null;
}

/**
 * A deliberately tiny file inbox shared with the Codex plugin hook.
 *
 * The hook only writes declarative enable/disable/status commands. It never
 * gains access to the guardian process, authentication, or arbitrary code
 * execution. Files are claimed with an atomic rename before processing so a
 * second app instance cannot execute the same command concurrently.
 */
export class CommandInbox {
  readonly #directory: string;
  readonly #pollIntervalMs: number;
  readonly #maxAttempts: number;
  readonly #now: () => number;
  readonly #onInvalid: ((fileName: string, reason: string) => void) | undefined;
  readonly #onFailure: ((failure: CommandInboxFailure) => void) | undefined;
  #timer: NodeJS.Timeout | null = null;
  #drainPromise: Promise<void> | null = null;
  #listener: ((command: GuardianCommand) => Promise<void> | void) | null = null;

  constructor(options: CommandInboxOptions) {
    this.#directory = options.directory;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#maxAttempts = normalizeMaxAttempts(options.maxAttempts);
    this.#now = options.now ?? Date.now;
    this.#onInvalid = options.onInvalid;
    this.#onFailure = options.onFailure;
  }

  async start(listener: (command: GuardianCommand) => Promise<void> | void): Promise<void> {
    if (this.#timer !== null) {
      return;
    }
    this.#listener = listener;
    try {
      await this.#recoverAbandonedClaims();
    } catch (error) {
      this.#reportFailure({
        phase: "recovery",
        fileName: null,
        reason: errorMessage(error),
        attempt: null,
        willRetry: true,
        deadLetterPath: null,
      });
    }
    await this.drain();
    this.#timer = setInterval(() => {
      // drain() contains its own error boundary. Keeping that boundary here,
      // rather than relying on every timer caller to remember a catch, avoids
      // process-level unhandled rejections after transient filesystem errors.
      void this.drain();
    }, this.#pollIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#listener = null;
  }

  drain(): Promise<void> {
    if (this.#drainPromise !== null) {
      return this.#drainPromise;
    }
    const drain = this.#drain()
      .catch((error: unknown) => {
        this.#reportFailure({
          phase: "drain",
          fileName: null,
          reason: errorMessage(error),
          attempt: null,
          willRetry: true,
          deadLetterPath: null,
        });
      })
      .finally(() => {
        if (this.#drainPromise === drain) {
          this.#drainPromise = null;
        }
      });
    this.#drainPromise = drain;
    return drain;
  }

  async #drain(): Promise<void> {
    const listener = this.#listener;
    if (listener === null) {
      return;
    }

    let entries: string[];
    try {
      entries = (await readdir(this.#directory))
        .filter((entry) => entry.endsWith(".json"))
        .sort();
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const retry = parseRetryFileName(entry);
      const source = path.join(this.#directory, entry);
      const claimed = `${source}.processing-${process.pid}`;
      try {
        await rename(source, claimed);
      } catch (error) {
        if (isNotFound(error)) {
          continue;
        }
        throw error;
      }

      let contents: string;
      try {
        contents = await readBoundedRegularCommandFile(claimed);
      } catch (error) {
        if (error instanceof InvalidCommandFileError) {
          this.#reportInvalid(entry, error.message);
          await discardInvalidClaim(claimed);
          continue;
        }
        const attempt = retry.completedFailures + 1;
        const outcome = await this.#retryOrDeadLetter(
          claimed,
          retry.baseName,
          attempt,
        );
        this.#reportFailure({
          phase: "read",
          fileName: entry,
          reason: errorMessage(error),
          attempt,
          willRetry: outcome.willRetry,
          deadLetterPath: outcome.deadLetterPath,
        });
        if (!outcome.willRetry) {
          continue;
        }
        return;
      }

      const parsed = parseGuardianCommandResult(contents, this.#now());
      if (parsed.command === null) {
        this.#reportInvalid(entry, parsed.reason);
        await unlink(claimed).catch((error: unknown) => {
          if (!isNotFound(error)) {
            throw error;
          }
        });
        continue;
      }
      const command = parsed.command;

      try {
        await listener(command);
      } catch (error) {
        const attempt = retry.completedFailures + 1;
        const outcome = await this.#retryOrDeadLetter(
          claimed,
          retry.baseName,
          attempt,
        );
        this.#reportFailure({
          phase: "listener",
          fileName: entry,
          reason: errorMessage(error),
          attempt,
          willRetry: outcome.willRetry,
          deadLetterPath: outcome.deadLetterPath,
        });
        // Retriable failures preserve strict command order. Once the bounded
        // retry budget is exhausted, the poison command is isolated and later
        // commands may continue in this same drain.
        if (!outcome.willRetry) {
          continue;
        }
        return;
      }

      await unlink(claimed).catch((error: unknown) => {
        if (!isNotFound(error)) {
          throw error;
        }
      });
    }
  }

  async #retryOrDeadLetter(
    claimedPath: string,
    baseName: string,
    attempt: number,
  ): Promise<{ willRetry: boolean; deadLetterPath: string | null }> {
    if (attempt < this.#maxAttempts) {
      const retryName = withRetryCount(baseName, attempt);
      await rename(claimedPath, path.join(this.#directory, retryName));
      return { willRetry: true, deadLetterPath: null };
    }

    const deadLetterDirectory = path.join(this.#directory, ".dead-letter");
    await mkdir(deadLetterDirectory, { recursive: true, mode: 0o700 });
    const stem = baseName.endsWith(".json")
      ? baseName.slice(0, -".json".length)
      : baseName;
    const deadLetterPath = path.join(
      deadLetterDirectory,
      `${stem}.failed-${this.#now()}-${randomUUID()}.json`,
    );
    await rename(claimedPath, deadLetterPath);
    return { willRetry: false, deadLetterPath };
  }

  #reportFailure(failure: CommandInboxFailure): void {
    // Operational failures and malformed input are separate channels. Calling
    // onInvalid here used to report the same failure twice when callers also
    // subscribed to onFailure.
    try {
      this.#onFailure?.(failure);
    } catch {
      // Best-effort diagnostics only.
    }
  }

  #reportInvalid(fileName: string, reason: string): void {
    try {
      this.#onInvalid?.(fileName, reason);
    } catch {
      // Invalid input must not be able to terminate the polling loop.
    }
  }

  async #recoverAbandonedClaims(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.#directory);
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }

    for (const entry of entries.sort()) {
      const match = /^(.*\.json)\.processing-\d+$/u.exec(entry);
      if (match?.[1] === undefined) {
        continue;
      }
      const claimed = path.join(this.#directory, entry);
      const source = path.join(this.#directory, match[1]);
      try {
        await rename(claimed, source);
      } catch (error) {
        // If the original name already exists, both commands are declarative
        // and idempotent; leave the claim for a later manual inspection rather
        // than overwrite a newer command.
        if (!isAlreadyExists(error) && !isNotFound(error)) {
          throw error;
        }
      }
    }
  }
}

export function parseGuardianCommand(
  contents: string,
  now: number = Date.now(),
): GuardianCommand | null {
  return parseGuardianCommandResult(contents, now).command;
}

function parseGuardianCommandResult(
  contents: string,
  now: number,
): { command: GuardianCommand | null; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return { command: null, reason: "命令不是有效 JSON" };
  }
  if (!isRecord(value)) {
    return { command: null, reason: "命令格式无效" };
  }
  const action = value.action;
  const turnId = value.turnId;
  if (
    typeof value.id !== "string" ||
    !/^[0-9A-Za-z-]{1,128}$/u.test(value.id) ||
    (action !== "enable" && action !== "disable" && action !== "status") ||
    typeof value.threadId !== "string" ||
    value.threadId.length === 0 ||
    (turnId !== null && typeof turnId !== "string") ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt)
  ) {
    return { command: null, reason: "命令格式无效" };
  }
  if (!Number.isFinite(now)) {
    return { command: null, reason: "无法验证命令时间" };
  }
  if (value.createdAt < now - COMMAND_TTL_MS) {
    return { command: null, reason: "命令已超过 5 分钟有效期" };
  }
  if (value.createdAt > now + MAX_FUTURE_CLOCK_SKEW_MS) {
    return { command: null, reason: "命令时间超过允许的 1 分钟时钟偏差" };
  }
  return {
    command: {
      id: value.id,
      action,
      threadId: value.threadId,
      turnId,
      createdAt: value.createdAt,
    },
    reason: "",
  };
}

class InvalidCommandFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCommandFileError";
  }
}

async function readBoundedRegularCommandFile(filePath: string): Promise<string> {
  let pathStat: Awaited<ReturnType<typeof lstat>>;
  try {
    pathStat = await lstat(filePath);
  } catch (error) {
    throw error;
  }
  if (pathStat.isSymbolicLink()) {
    throw new InvalidCommandFileError("拒绝读取符号链接命令文件");
  }
  if (!pathStat.isFile()) {
    throw new InvalidCommandFileError("拒绝读取非普通命令文件");
  }
  if (pathStat.size > MAX_COMMAND_FILE_BYTES) {
    throw new InvalidCommandFileError("命令文件超过 64 KiB 安全上限");
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isSymbolicLinkOpenError(error)) {
      throw new InvalidCommandFileError("拒绝读取符号链接命令文件");
    }
    throw error;
  }

  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) {
      throw new InvalidCommandFileError("拒绝读取非普通命令文件");
    }
    if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new InvalidCommandFileError("命令文件在安全检查期间发生变化");
    }
    if (openedStat.size > MAX_COMMAND_FILE_BYTES) {
      throw new InvalidCommandFileError("命令文件超过 64 KiB 安全上限");
    }
    const buffer = Buffer.allocUnsafe(MAX_COMMAND_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        total,
      );
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
    }
    if (total > MAX_COMMAND_FILE_BYTES) {
      throw new InvalidCommandFileError("命令文件超过 64 KiB 安全上限");
    }
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function discardInvalidClaim(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    // unlink intentionally does not recurse into a directory masquerading as
    // a command. An empty impostor directory can be removed safely; a nonempty
    // one remains under its claimed name and is never traversed.
    if (isDirectory(error)) {
      await rmdir(filePath).catch((directoryError: unknown) => {
        if (!isNotFound(directoryError) && !isNotEmpty(directoryError)) {
          throw directoryError;
        }
      });
      return;
    }
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function isSymbolicLinkOpenError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ELOOP" || error.code === "EMLINK")
  );
}

function isDirectory(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EISDIR" || error.code === "EPERM")
  );
}

function isNotEmpty(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOTEMPTY" || error.code === "EEXIST")
  );
}

function normalizeMaxAttempts(value: number | undefined): number {
  if (value === undefined) {
    return 3;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }
  return value;
}

function parseRetryFileName(fileName: string): {
  baseName: string;
  completedFailures: number;
} {
  const match = /^(.*)\.retry-(\d+)\.json$/u.exec(fileName);
  if (match?.[1] === undefined || match[2] === undefined) {
    return { baseName: fileName, completedFailures: 0 };
  }
  const completedFailures = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(completedFailures) || completedFailures < 1) {
    return { baseName: fileName, completedFailures: 0 };
  }
  return {
    baseName: `${match[1]}.json`,
    completedFailures,
  };
}

function withRetryCount(baseName: string, completedFailures: number): string {
  const stem = baseName.endsWith(".json")
    ? baseName.slice(0, -".json".length)
    : baseName;
  return `${stem}.retry-${completedFailures}.json`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
