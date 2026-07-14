import assert from "node:assert/strict";
import test from "node:test";

import { hasUsageLimitError } from "../src/core/events.js";

test("detects a structured top-level UsageLimitExceeded error", () => {
  assert.equal(
    hasUsageLimitError({
      type: "error",
      codex_error_info: "usageLimitExceeded",
      message: "limit reached",
    }),
    true,
  );
  assert.equal(
    hasUsageLimitError({
      type: "turn.failed",
      error: { error_type: "UsageLimitExceeded", message: "limit reached" },
    }),
    true,
  );
});

test("does not mistake text or nested sub-agent errors for a top-level limit", () => {
  assert.equal(
    hasUsageLimitError({ type: "error", message: "UsageLimitExceeded" }),
    false,
  );
  assert.equal(
    hasUsageLimitError({
      type: "item.completed",
      item: {
        type: "collab_tool_call",
        agents_states: {
          child: { error_type: "UsageLimitExceeded" },
        },
      },
    }),
    false,
  );
});
