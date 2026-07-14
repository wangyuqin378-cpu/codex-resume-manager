import type {
  QuotaLimit,
  QuotaSnapshot,
  QuotaWait,
  QuotaWindow,
  QuotaWindowName,
} from "../shared/types.js";

const RESUME_SAFETY_MARGIN_MS = 60_000;
const LEGACY_LIMIT_ID = "__legacy__";

export type QuotaWindowKind = "five_hour" | "weekly" | "other";

interface ParseResult<T> {
  ok: boolean;
  value: T | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasLimitShape(value: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(value, "primary") ||
    Object.hasOwn(value, "secondary") ||
    Object.hasOwn(value, "rateLimitReachedType")
  );
}

export function remainingPercent(usedPercent: number): number {
  return 100 - usedPercent;
}

/** Field position is not semantic: Codex may return the weekly window as primary. */
export function classifyQuotaWindowDuration(
  windowDurationMins: number | null,
): QuotaWindowKind {
  if (windowDurationMins === 300) {
    return "five_hour";
  }
  if (windowDurationMins === 10_080) {
    return "weekly";
  }
  return "other";
}

function parseWindow(
  value: unknown,
  name: QuotaWindowName,
  limitId: string,
  limitName: string | null,
): ParseResult<QuotaWindow> {
  if (value === null || value === undefined) {
    return { ok: true, value: null };
  }

  if (!isRecord(value)) {
    return { ok: false, value: null };
  }

  const usedPercent = finiteNumber(value.usedPercent);
  const duration = value.windowDurationMins;
  const reset = value.resetsAt;

  if (
    usedPercent === null ||
    (duration !== null && duration !== undefined && finiteNumber(duration) === null) ||
    (reset !== null && reset !== undefined && finiteNumber(reset) === null)
  ) {
    return { ok: false, value: null };
  }

  const windowDurationMins = duration === null || duration === undefined
    ? null
    : (duration as number);
  const resetsAt = reset === null || reset === undefined
    ? null
    : (reset as number) * 1_000;

  return {
    ok: true,
    value: {
      name,
      limitId,
      limitName,
      usedPercent,
      remainingPercent: remainingPercent(usedPercent),
      windowDurationMins,
      resetsAt,
    },
  };
}

function parseLimit(
  value: unknown,
  fallbackLimitId: string,
  requireMatchingLimitId: boolean,
): ParseResult<QuotaLimit> {
  if (!isRecord(value) || !hasLimitShape(value)) {
    return { ok: false, value: null };
  }

  const rawLimitId = value.limitId;
  if (
    rawLimitId !== null &&
    rawLimitId !== undefined &&
    (typeof rawLimitId !== "string" || rawLimitId.length === 0)
  ) {
    return { ok: false, value: null };
  }
  const limitId = typeof rawLimitId === "string" ? rawLimitId : fallbackLimitId;
  if (
    limitId.length === 0 ||
    (requireMatchingLimitId && limitId !== fallbackLimitId)
  ) {
    return { ok: false, value: null };
  }

  const rawLimitName = value.limitName;
  if (
    rawLimitName !== null &&
    rawLimitName !== undefined &&
    typeof rawLimitName !== "string"
  ) {
    return { ok: false, value: null };
  }
  const limitName = typeof rawLimitName === "string" ? rawLimitName : null;

  const primary = parseWindow(value.primary, "primary", limitId, limitName);
  const secondary = parseWindow(value.secondary, "secondary", limitId, limitName);
  if (!primary.ok || !secondary.ok) {
    return { ok: false, value: null };
  }

  const reachedType = value.rateLimitReachedType;
  if (
    reachedType !== null &&
    reachedType !== undefined &&
    typeof reachedType !== "string"
  ) {
    return { ok: false, value: null };
  }

  return {
    ok: true,
    value: {
      limitId,
      limitName,
      primary: primary.value,
      secondary: secondary.value,
      rateLimitReachedType: typeof reachedType === "string" ? reachedType : null,
    },
  };
}

function parseLimitsById(
  value: unknown,
): ParseResult<Record<string, QuotaLimit>> {
  if (!isRecord(value)) {
    return { ok: false, value: null };
  }

  const parsed: Record<string, QuotaLimit> = {};
  for (const limitId of Object.keys(value).sort()) {
    if (limitId.length === 0) {
      return { ok: false, value: null };
    }
    const limit = parseLimit(value[limitId], limitId, true);
    if (!limit.ok || limit.value === null) {
      return { ok: false, value: null };
    }
    parsed[limitId] = limit.value;
  }
  return { ok: true, value: parsed };
}

/**
 * Parses `account/rateLimits/read` and rate-limit notifications into one stable
 * representation. `rateLimitsByLimitId` is authoritative when available;
 * `primary` and `secondary` remain a single-bucket projection for the existing
 * UI. App Server reset timestamps are Unix seconds; persisted timestamps are
 * always milliseconds.
 */
export function parseQuotaSnapshot(
  value: unknown,
  capturedAt: number = Date.now(),
): QuotaSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const directSingle = hasLimitShape(value) ? value : null;
  const wrappedSingle = isRecord(value.rateLimits) && hasLimitShape(value.rateLimits)
    ? value.rateLimits
    : null;
  const rawSingle = wrappedSingle ?? directSingle;
  const single = rawSingle === null
    ? { ok: true, value: null }
    : parseLimit(rawSingle, LEGACY_LIMIT_ID, false);

  const rawMulti = value.rateLimitsByLimitId;
  const hasMultiPayload = rawMulti !== null && rawMulti !== undefined;
  const multi = hasMultiPayload
    ? parseLimitsById(rawMulti)
    : { ok: true, value: {} as Record<string, QuotaLimit> };

  if ((!single.ok && !multi.ok) || (hasMultiPayload && !multi.ok)) {
    return null;
  }

  const rateLimitsByLimitId = multi.value ?? {};
  if (Object.keys(rateLimitsByLimitId).length === 0 && single.value !== null) {
    rateLimitsByLimitId[single.value.limitId] = single.value;
  }

  const firstMultiId = Object.keys(rateLimitsByLimitId)[0];
  const projected = single.ok && single.value !== null
    ? single.value
    : rateLimitsByLimitId.codex ??
      (firstMultiId === undefined ? null : rateLimitsByLimitId[firstMultiId] ?? null);

  if (projected === null || Object.keys(rateLimitsByLimitId).length === 0) {
    return null;
  }

  return {
    primary: projected.primary,
    secondary: projected.secondary,
    rateLimitReachedType: projected.rateLimitReachedType,
    rateLimitsByLimitId,
    capturedAt,
  };
}

function allQuotaWindows(snapshot: QuotaSnapshot): QuotaWindow[] {
  const limits = snapshot.rateLimitsByLimitId;
  if (limits !== undefined && Object.keys(limits).length > 0) {
    return Object.values(limits).flatMap((limit) =>
      [limit.primary, limit.secondary].filter(
        (window): window is QuotaWindow => window !== null,
      ),
    );
  }
  return [snapshot.primary, snapshot.secondary].filter(
    (window): window is QuotaWindow => window !== null,
  );
}

export function getBlockingWindows(snapshot: QuotaSnapshot): QuotaWindow[] {
  return allQuotaWindows(snapshot).filter((window) => window.usedPercent >= 100);
}

/** Returns null when there is no block or a blocked window lacks a reset time. */
export function computeResumeAfter(snapshot: QuotaSnapshot): number | null {
  const blocked = getBlockingWindows(snapshot);
  if (blocked.length === 0 || blocked.some((window) => window.resetsAt === null)) {
    return null;
  }

  return (
    Math.max(...blocked.map((window) => window.resetsAt as number)) +
    RESUME_SAFETY_MARGIN_MS
  );
}

export function makeResumeKey(
  threadId: string,
  failedTurnId: string,
  resetAt: number | null,
): string {
  return JSON.stringify([threadId, failedTurnId, resetAt]);
}

export function makeQuotaWait(
  threadId: string,
  failedTurnId: string,
  snapshot: QuotaSnapshot,
  attemptCount: number,
): QuotaWait | null {
  const blockedWindows = getBlockingWindows(snapshot);
  if (blockedWindows.length === 0) {
    return null;
  }

  const resumeAfter = computeResumeAfter(snapshot);
  const latestReset = resumeAfter === null
    ? null
    : Math.max(...blockedWindows.map((window) => window.resetsAt as number));

  return {
    failedTurnId,
    blockedWindows,
    resumeAfter,
    attemptCount,
    idempotencyKey: makeResumeKey(threadId, failedTurnId, latestReset),
  };
}

function stableLimitId(window: QuotaWindow): string {
  return window.limitId ?? LEGACY_LIMIT_ID;
}

function sameStableWindow(left: QuotaWindow, right: QuotaWindow): boolean {
  return (
    stableLimitId(left) === stableLimitId(right) &&
    left.windowDurationMins === right.windowDurationMins
  );
}

export function areBlockedWindowsRestored(
  wait: QuotaWait,
  snapshot: QuotaSnapshot,
  now: number = Date.now(),
): boolean {
  if (wait.resumeAfter === null || now < wait.resumeAfter) {
    return false;
  }

  const currentWindows = allQuotaWindows(snapshot);
  // A newly blocked bucket is just as unsafe as one that caused the original
  // failure. Never resume while any current App Server window is exhausted.
  if (currentWindows.some((window) => window.usedPercent >= 100)) {
    return false;
  }

  return wait.blockedWindows.every((blockedWindow) => {
    const currentWindow = currentWindows.find((window) =>
      sameStableWindow(blockedWindow, window),
    );
    return currentWindow !== undefined && currentWindow.usedPercent < 100;
  });
}
