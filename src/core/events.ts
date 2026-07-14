function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUsageLimitTag(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return value.replace(/[\s_-]/gu, "").toLowerCase() === "usagelimitexceeded";
}

/**
 * App Server usually emits the string variant, while newer protocol bindings
 * may encode enum variants as a one-level tagged object. Keep this check
 * deliberately shallow: tool and sub-agent payloads must never become evidence
 * that the watched top-level turn hit the user's quota.
 */
function isUsageLimitVariant(value: unknown): boolean {
  if (isUsageLimitTag(value)) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  if (
    [value.type, value.code, value.kind, value.variant].some(isUsageLimitTag)
  ) {
    return true;
  }
  return Object.keys(value).some(isUsageLimitTag);
}

function recordHasUsageLimitTag(value: Record<string, unknown>): boolean {
  return [
    value.codexErrorInfo,
    value.codex_error_info,
    value.errorType,
    value.error_type,
    value.code,
    value.kind,
    value.variant,
  ].some(isUsageLimitVariant);
}

/**
 * Detects only a structured error on the top-level turn payload. It intentionally
 * does not recursively scan tool, MCP, or sub-agent payloads.
 */
export function hasUsageLimitError(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  if (isUsageLimitTag(value.type) || recordHasUsageLimitTag(value)) {
    return true;
  }

  if (value.type !== "error" && value.type !== "turn.failed") {
    return false;
  }

  if (isUsageLimitVariant(value.error)) {
    return true;
  }

  return isRecord(value.error) &&
    (isUsageLimitTag(value.error.type) || recordHasUsageLimitTag(value.error));
}
