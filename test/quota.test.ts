import assert from "node:assert/strict";
import test from "node:test";

import {
  areBlockedWindowsRestored,
  classifyQuotaWindowDuration,
  computeResumeAfter,
  getBlockingWindows,
  makeQuotaWait,
  makeResumeKey,
  parseQuotaSnapshot,
  remainingPercent,
} from "../src/core/quota.js";
import {
  createEmptyStateV2,
  isAppStateV2,
} from "../src/shared/types.js";

test("parses App Server camelCase quota windows and converts reset seconds", () => {
  const snapshot = parseQuotaSnapshot(
    {
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: {
          usedPercent: 72.5,
          windowDurationMins: 300,
          resetsAt: 1_800_000_000,
        },
        secondary: {
          usedPercent: 18,
          windowDurationMins: 10_080,
          resetsAt: 1_800_100_000,
        },
        rateLimitReachedType: null,
      },
    },
    123,
  );

  assert.ok(snapshot);
  assert.deepEqual(snapshot, {
    primary: {
      name: "primary",
      limitId: "codex",
      limitName: "Codex",
      usedPercent: 72.5,
      remainingPercent: 27.5,
      windowDurationMins: 300,
      resetsAt: 1_800_000_000_000,
    },
    secondary: {
      name: "secondary",
      limitId: "codex",
      limitName: "Codex",
      usedPercent: 18,
      remainingPercent: 82,
      windowDurationMins: 10_080,
      resetsAt: 1_800_100_000_000,
    },
    rateLimitReachedType: null,
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: "Codex",
        primary: {
          name: "primary",
          limitId: "codex",
          limitName: "Codex",
          usedPercent: 72.5,
          remainingPercent: 27.5,
          windowDurationMins: 300,
          resetsAt: 1_800_000_000_000,
        },
        secondary: {
          name: "secondary",
          limitId: "codex",
          limitName: "Codex",
          usedPercent: 18,
          remainingPercent: 82,
          windowDurationMins: 10_080,
          resetsAt: 1_800_100_000_000,
        },
        rateLimitReachedType: null,
      },
    },
    capturedAt: 123,
  });
});

test("accepts the official null rateLimitsByLimitId fallback", () => {
  const snapshot = parseQuotaSnapshot(
    {
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: {
          usedPercent: 40,
          windowDurationMins: 300,
          resetsAt: 1_800_000_000,
        },
        secondary: null,
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
    },
    456,
  );

  assert.ok(snapshot);
  assert.equal(snapshot.primary?.limitId, "codex");
  assert.equal(snapshot.primary?.remainingPercent, 60);
  assert.equal(snapshot.rateLimitsByLimitId?.codex?.primary?.usedPercent, 40);
  assert.equal(snapshot.capturedAt, 456);
});

test("parses every official rateLimitsByLimitId bucket with stable identities", () => {
  const snapshot = parseQuotaSnapshot({
    rateLimits: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 100 },
      secondary: null,
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 100 },
        secondary: null,
        rateLimitReachedType: null,
      },
      codex_other: {
        limitId: "codex_other",
        limitName: "Other Codex work",
        primary: { usedPercent: 100, windowDurationMins: 60, resetsAt: 200 },
        secondary: null,
        rateLimitReachedType: "primary",
      },
    },
  }, 999);

  assert.ok(snapshot);
  assert.deepEqual(Object.keys(snapshot.rateLimitsByLimitId ?? {}), [
    "codex",
    "codex_other",
  ]);
  assert.equal(snapshot.primary?.limitId, "codex");
  assert.equal(snapshot.rateLimitsByLimitId?.codex_other?.limitName, "Other Codex work");
  assert.equal(
    snapshot.rateLimitsByLimitId?.codex_other?.primary?.resetsAt,
    200_000,
  );
  assert.deepEqual(
    getBlockingWindows(snapshot).map((window) => [
      window.limitId,
      window.windowDurationMins,
    ]),
    [["codex_other", 60]],
  );
});

test("remaining percentage is exactly 100 minus used percentage", () => {
  assert.equal(remainingPercent(0), 100);
  assert.equal(remainingPercent(37.25), 62.75);
  assert.equal(remainingPercent(101), -1);
});

test("classifies quota windows by duration instead of primary/secondary position", () => {
  assert.equal(classifyQuotaWindowDuration(300), "five_hour");
  assert.equal(classifyQuotaWindowDuration(10_080), "weekly");
  assert.equal(classifyQuotaWindowDuration(null), "other");
  assert.equal(classifyQuotaWindowDuration(1_440), "other");
});

test("only windows at or above 100 percent block execution", () => {
  const snapshot = parseQuotaSnapshot({
    primary: { usedPercent: 99.99, windowDurationMins: 300, resetsAt: 100 },
    secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: 200 },
  });

  assert.ok(snapshot);
  assert.deepEqual(
    getBlockingWindows(snapshot).map((window) => window.name),
    ["secondary"],
  );
});

test("resume time uses the latest blocked reset plus sixty seconds", () => {
  const snapshot = parseQuotaSnapshot({
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 100 },
    secondary: { usedPercent: 105, windowDurationMins: 10_080, resetsAt: 250 },
  });

  assert.ok(snapshot);
  assert.equal(computeResumeAfter(snapshot), 310_000);

  const wait = makeQuotaWait("thread-1", "turn-9", snapshot, 2);
  assert.ok(wait);
  assert.equal(wait.resumeAfter, 310_000);
  assert.equal(wait.attemptCount, 2);
  assert.equal(wait.idempotencyKey, makeResumeKey("thread-1", "turn-9", 250_000));
});

test("keeps a representable wait without inventing a reset time", () => {
  const snapshot = parseQuotaSnapshot({
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null },
    secondary: null,
  });

  assert.ok(snapshot);
  assert.equal(computeResumeAfter(snapshot), null);
  const wait = makeQuotaWait("thread-1", "turn-1", snapshot, 0);
  assert.ok(wait);
  assert.equal(wait.resumeAfter, null);
  assert.equal(wait.blockedWindows.length, 1);
  assert.equal(wait.idempotencyKey, makeResumeKey("thread-1", "turn-1", null));
});

test("restoration requires the safety time and every formerly blocked window", () => {
  const blocked = parseQuotaSnapshot({
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 100 },
    secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: 200 },
  });
  assert.ok(blocked);
  const wait = makeQuotaWait("thread-1", "turn-1", blocked, 0);
  assert.ok(wait);

  const restored = parseQuotaSnapshot({
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 300 },
    secondary: { usedPercent: 8, windowDurationMins: 10_080, resetsAt: 400 },
  });
  assert.ok(restored);

  const resumeAfter = wait.resumeAfter;
  assert.notEqual(resumeAfter, null);
  if (resumeAfter === null) {
    return;
  }
  assert.equal(areBlockedWindowsRestored(wait, restored, resumeAfter - 1), false);
  assert.equal(areBlockedWindowsRestored(wait, restored, resumeAfter), true);

  const stillBlocked = parseQuotaSnapshot({
    primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 300 },
    secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: 400 },
  });
  assert.ok(stillBlocked);
  assert.equal(areBlockedWindowsRestored(wait, stillBlocked, resumeAfter), false);

  const missingSecondary = parseQuotaSnapshot({
    primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 300 },
    secondary: null,
  });
  assert.ok(missingSecondary);
  assert.equal(
    areBlockedWindowsRestored(wait, missingSecondary, resumeAfter),
    false,
  );
});

test("restoration matches limitId plus duration when primary and secondary swap", () => {
  const blocked = parseQuotaSnapshot({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 100 },
        secondary: { usedPercent: 25, windowDurationMins: 10_080, resetsAt: 200 },
        rateLimitReachedType: "primary",
      },
    },
  });
  assert.ok(blocked);
  const wait = makeQuotaWait("thread-swap", "turn-swap", blocked, 1);
  assert.ok(wait);
  assert.notEqual(wait.resumeAfter, null);

  const restoredWithSwappedSlots = parseQuotaSnapshot({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 26, windowDurationMins: 10_080, resetsAt: 300 },
        secondary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 400 },
        rateLimitReachedType: null,
      },
    },
  });
  assert.ok(restoredWithSwappedSlots);
  assert.equal(
    areBlockedWindowsRestored(
      wait,
      restoredWithSwappedSlots,
      wait.resumeAfter ?? 0,
    ),
    true,
  );
});

test("a newly blocked bucket prevents recovery even when the original bucket reset", () => {
  const blocked = parseQuotaSnapshot({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 100 },
        secondary: null,
        rateLimitReachedType: "primary",
      },
    },
  });
  assert.ok(blocked);
  const wait = makeQuotaWait("thread-new-block", "turn-new-block", blocked, 1);
  assert.ok(wait);

  const current = parseQuotaSnapshot({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 2, windowDurationMins: 300, resetsAt: 300 },
        secondary: null,
        rateLimitReachedType: null,
      },
      codex_other: {
        limitId: "codex_other",
        limitName: "Other Codex work",
        primary: { usedPercent: 100, windowDurationMins: 60, resetsAt: 400 },
        secondary: null,
        rateLimitReachedType: "primary",
      },
    },
  });
  assert.ok(current);
  assert.equal(
    areBlockedWindowsRestored(wait, current, wait.resumeAfter ?? 0),
    false,
  );
});

test("rejects malformed App Server quota fields", () => {
  assert.equal(parseQuotaSnapshot({ unrelated: true }), null);
  assert.equal(
    parseQuotaSnapshot({
      primary: { usedPercent: "100", windowDurationMins: 300, resetsAt: 100 },
    }),
    null,
  );
});

test("accepts sparse quota windows because only usedPercent is required", () => {
  const snapshot = parseQuotaSnapshot({
    rateLimits: {
      primary: { usedPercent: 42 },
      secondary: null,
    },
  }, 456);

  assert.ok(snapshot);
  assert.deepEqual(snapshot.primary, {
    name: "primary",
    limitId: "__legacy__",
    limitName: null,
    usedPercent: 42,
    remainingPercent: 58,
    windowDurationMins: null,
    resetsAt: null,
  });
  assert.deepEqual(Object.keys(snapshot.rateLimitsByLimitId ?? {}), ["__legacy__"]);
  assert.equal(snapshot.capturedAt, 456);
});

test("persisted-state validation accepts both V3 identities and pre-V3 snapshots", () => {
  const v3Quota = parseQuotaSnapshot({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 100 },
        secondary: null,
        rateLimitReachedType: null,
      },
    },
  });
  assert.ok(v3Quota);
  const v3State = createEmptyStateV2(1);
  v3State.quota = v3Quota;
  assert.equal(isAppStateV2(v3State), true);

  const legacyState = createEmptyStateV2(2);
  legacyState.quota = {
    primary: {
      name: "primary",
      usedPercent: 12,
      remainingPercent: 88,
      windowDurationMins: 300,
      resetsAt: 100_000,
    },
    secondary: null,
    rateLimitReachedType: null,
    capturedAt: 2,
  };
  assert.equal(isAppStateV2(legacyState), true);

  const mismatchedIdentity = structuredClone(v3State) as unknown as {
    state?: unknown;
    quota: { rateLimitsByLimitId?: Record<string, { primary?: { limitId?: string } }> };
  };
  if (mismatchedIdentity.quota.rateLimitsByLimitId?.codex?.primary !== undefined) {
    mismatchedIdentity.quota.rateLimitsByLimitId.codex.primary.limitId = "other";
  }
  assert.equal(isAppStateV2(mismatchedIdentity), false);
});
