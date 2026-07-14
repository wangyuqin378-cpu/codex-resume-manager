import { hasUsageLimitError } from "./events.js";
import {
  MAX_TASK_OUTPUT_TEXT_LENGTH,
  type TaskOutput,
} from "../shared/types.js";

type JsonObject = Record<string, unknown>;

export type ProjectedThreadStatus =
  | "idle"
  | "active"
  | "notLoaded"
  | "systemError";

export interface ProjectedTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: JsonObject | null;
  output: TaskOutput | null;
}

export interface ProjectedThread {
  id: string;
  cwd: string;
  title: string | null;
  parentThreadId: string | null;
  status: ProjectedThreadStatus;
  turns: ProjectedTurn[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectTurn(value: unknown): ProjectedTurn | null {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    (value.status !== "completed" &&
      value.status !== "interrupted" &&
      value.status !== "failed" &&
      value.status !== "inProgress") ||
    (value.error !== null && value.error !== undefined && !isObject(value.error))
  ) {
    return null;
  }
  return {
    id: value.id,
    status: value.status,
    error: isObject(value.error) ? value.error : null,
    output: taskOutputFromItems(value.items),
  };
}

function taskOutputFromItems(value: unknown): TaskOutput | null {
  if (!Array.isArray(value)) {
    return null;
  }
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const item = value[index];
    if (!isObject(item) || item.type !== "agentMessage" || typeof item.text !== "string") {
      continue;
    }
    try {
      const parsed = JSON.parse(item.text) as unknown;
      return isTaskOutput(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function isTaskOutput(value: unknown): value is TaskOutput {
  if (!isObject(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  return (
    keys.length === 3 &&
    keys[0] === "message" &&
    keys[1] === "status" &&
    keys[2] === "verification" &&
    (value.status === "complete" ||
      value.status === "needs_input" ||
      value.status === "blocked") &&
    typeof value.message === "string" &&
    value.message.length <= MAX_TASK_OUTPUT_TEXT_LENGTH &&
    (value.verification === null ||
      (typeof value.verification === "string" &&
        value.verification.length <= MAX_TASK_OUTPUT_TEXT_LENGTH))
  );
}

function projectStatus(value: unknown): ProjectedThreadStatus | null {
  if (!isObject(value)) {
    return null;
  }
  return value.type === "idle" ||
    value.type === "active" ||
    value.type === "notLoaded" ||
    value.type === "systemError"
    ? value.type
    : null;
}

/** Strictly projects the documented App Server `Thread` shape we rely on. */
export function projectThread(value: unknown): ProjectedThread | null {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    typeof value.cwd !== "string" ||
    (value.parentThreadId !== undefined &&
      value.parentThreadId !== null &&
      typeof value.parentThreadId !== "string") ||
    !Array.isArray(value.turns)
  ) {
    return null;
  }
  const status = projectStatus(value.status);
  if (status === null) {
    return null;
  }
  const turns = value.turns.map(projectTurn);
  if (turns.some((turn) => turn === null)) {
    return null;
  }
  const name = typeof value.name === "string" && value.name.trim().length > 0
    ? value.name.trim()
    : null;
  const preview = typeof value.preview === "string" && value.preview.trim().length > 0
    ? value.preview.trim()
    : null;
  return {
    id: value.id,
    cwd: value.cwd,
    title: name ?? preview,
    parentThreadId:
      typeof value.parentThreadId === "string" ? value.parentThreadId : null,
    status,
    turns: turns as ProjectedTurn[],
  };
}

export function latestTurnFromThread(value: unknown): ProjectedTurn | null {
  const thread = projectThread(value);
  return thread?.turns.at(-1) ?? null;
}

export function isThreadIdle(value: unknown): boolean {
  return projectThread(value)?.status === "idle";
}

/**
 * Returns a quota failure only when it is the latest turn on a top-level
 * Desktop thread and the turn's own structured error carries
 * `UsageLimitExceeded`. This never scans turn items or sub-agent payloads.
 */
export function topLevelUsageLimitFailure(value: unknown): ProjectedTurn | null {
  const thread = projectThread(value);
  if (thread === null || thread.parentThreadId !== null) {
    return null;
  }
  const latest = thread.turns.at(-1) ?? null;
  if (
    latest === null ||
    latest.status !== "failed" ||
    latest.error === null ||
    !hasUsageLimitError({ type: "turn.failed", error: latest.error })
  ) {
    return null;
  }
  return latest;
}
