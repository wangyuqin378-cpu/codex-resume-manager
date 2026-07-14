import assert from "node:assert/strict";
import test from "node:test";

import {
  latestTurnFromThread,
  projectThread,
  topLevelUsageLimitFailure,
} from "../src/core/thread.js";

function thread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "thread-1",
    cwd: "/tmp/project",
    name: "Important task",
    parentThreadId: null,
    status: { type: "idle" },
    turns: [
      {
        id: "turn-quota",
        status: "failed",
        error: {
          message: "Usage limit reached",
          codexErrorInfo: "usageLimitExceeded",
        },
      },
    ],
    ...overrides,
  };
}

test("projects the Desktop thread and its latest turn", () => {
  const projected = projectThread(thread());
  assert.deepEqual(projected, {
    id: "thread-1",
    cwd: "/tmp/project",
    title: "Important task",
    parentThreadId: null,
    status: "idle",
    turns: [
      {
        id: "turn-quota",
        status: "failed",
        error: {
          message: "Usage limit reached",
          codexErrorInfo: "usageLimitExceeded",
        },
        output: null,
      },
    ],
  });
  assert.equal(latestTurnFromThread(thread())?.id, "turn-quota");
});

test("projects only an exact structured task result from the final agent message", () => {
  for (const status of ["complete", "needs_input", "blocked"] as const) {
    const output = {
      status,
      message: `result: ${status}`,
      verification: status === "complete" ? "tests passed" : null,
    };
    const projected = projectThread(
      thread({
        turns: [
          {
            id: `turn-${status}`,
            status: "completed",
            error: null,
            items: [
              { type: "agentMessage", text: "intermediate prose" },
              { type: "agentMessage", text: JSON.stringify(output) },
            ],
          },
        ],
      }),
    );
    assert.deepEqual(projected?.turns[0]?.output, output);
  }
});

test("rejects malformed, fenced, or extended task results", () => {
  const invalid = [
    "not json",
    '```json\n{"status":"complete","message":"done","verification":null}\n```',
    JSON.stringify({ status: "complete", message: "done" }),
    JSON.stringify({
      status: "complete",
      message: "x".repeat(2_001),
      verification: null,
    }),
    JSON.stringify({
      status: "complete",
      message: "done",
      verification: "x".repeat(2_001),
    }),
    JSON.stringify({
      status: "complete",
      message: "done",
      verification: null,
      extra: true,
    }),
  ];

  for (const [index, text] of invalid.entries()) {
    const projected = projectThread(
      thread({
        turns: [
          {
            id: `turn-invalid-${index}`,
            status: "completed",
            error: null,
            items: [{ type: "agentMessage", text }],
          },
        ],
      }),
    );
    assert.equal(projected?.turns[0]?.output, null);
  }
});

test("recognizes only a structured quota failure on a top-level thread", () => {
  assert.equal(topLevelUsageLimitFailure(thread())?.id, "turn-quota");

  const objectVariant = thread({
    turns: [
      {
        id: "turn-object",
        status: "failed",
        error: {
          codexErrorInfo: { type: "usageLimitExceeded" },
        },
      },
    ],
  });
  assert.equal(topLevelUsageLimitFailure(objectVariant)?.id, "turn-object");

  const legacyTopLevel = thread();
  delete legacyTopLevel.parentThreadId;
  assert.equal(topLevelUsageLimitFailure(legacyTopLevel)?.id, "turn-quota");

  assert.equal(
    topLevelUsageLimitFailure(thread({ parentThreadId: "parent-thread" })),
    null,
  );
  assert.equal(
    topLevelUsageLimitFailure(
      thread({
        turns: [
          {
            id: "turn-nested",
            status: "failed",
            error: { message: "sub-agent failed" },
            items: [
              {
                type: "collabAgentToolCall",
                error: { codexErrorInfo: "usageLimitExceeded" },
              },
            ],
          },
        ],
      }),
    ),
    null,
  );
  assert.equal(
    topLevelUsageLimitFailure(
      thread({
        turns: [
          {
            id: "turn-message-only",
            status: "failed",
            error: { message: "Usage limit exceeded" },
          },
        ],
      }),
    ),
    null,
  );
});
