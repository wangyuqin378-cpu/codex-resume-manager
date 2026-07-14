import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CodexAppServerClient,
  RESUME_OUTPUT_SCHEMA,
} from "../src/main/codex-app-server.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

function fakeEnvironment(
  scenario: string,
  additions: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...additions,
    FAKE_CODEX_SCENARIO: scenario,
  };
}

test("app-server client handshakes, normalizes limits, merges notifications, and reads turns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-app-server-test-"));
  const tracePath = join(directory, "trace.jsonl");
  const client = new CodexAppServerClient({
    codexPath: process.execPath,
    codexArgs: [fixture],
    env: fakeEnvironment("app-server", { FAKE_CODEX_TRACE: tracePath }),
    requestTimeoutMs: 2_000,
  });

  try {
    const updated = new Promise<number>((resolveUpdate, reject) => {
      const timer = setTimeout(() => reject(new Error("notification timeout")), 1_000);
      client.onRateLimits((snapshot) => {
        clearTimeout(timer);
        resolveUpdate(snapshot.primary?.usedPercent ?? -1);
      });
    });

    const quota = await client.readRateLimits();
    assert.equal(quota.primary?.remainingPercent, 75);
    assert.equal(quota.primary?.resetsAt, 1_800_000_000_000);
    assert.equal(quota.secondary?.windowDurationMins, 10_080);
    assert.equal(await updated, 60);

    const thread = await client.readThread("thread-fake-1");
    assert.equal(thread.id, "thread-fake-1");
    assert.deepEqual(
      (thread.turns as Array<{ id: string }>).map((turn) => turn.id),
      ["turn-fake-last"],
    );

    assert.deepEqual(await client.readThreadGoal("thread-fake-1"), {
      objective: "Finish the fake project",
      status: "active",
    });
    assert.deepEqual(await client.readThreadGoal("thread-without-goal"), null);

    const hooks = await client.listHooks([directory]);
    assert.deepEqual(hooks.data, [
      {
        id: "codex-auto-resume",
        scope: "user",
        status: "trusted",
      },
    ]);

    const messages = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; line?: string });
    const stdin = messages
      .filter((entry) => entry.type === "stdin")
      .map((entry) => JSON.parse(entry.line ?? "{}") as { method: string; params?: unknown });
    assert.deepEqual(
      stdin.map((message) => message.method),
      [
        "initialize",
        "initialized",
        "account/rateLimits/read",
        "thread/read",
        "thread/goal/get",
        "thread/goal/get",
        "hooks/list",
      ],
    );
    assert.deepEqual(stdin[3]?.params, {
      threadId: "thread-fake-1",
      includeTurns: true,
    });
    assert.deepEqual(stdin[4]?.params, { threadId: "thread-fake-1" });
    assert.deepEqual(stdin[5]?.params, { threadId: "thread-without-goal" });
    assert.deepEqual(stdin[6]?.params, { cwds: [directory] });
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("app-server resumes and starts in place, and rejects unattended server requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-app-server-v2-test-"));
  const tracePath = join(directory, "trace.jsonl");
  const client = new CodexAppServerClient({
    codexPath: process.execPath,
    codexArgs: [fixture],
    env: fakeEnvironment("app-server", { FAKE_CODEX_TRACE: tracePath }),
    requestTimeoutMs: 2_000,
  });

  try {
    const requestSeen = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server request timeout")), 1_000);
      client.onServerRequest((event) => {
        clearTimeout(timer);
        resolve(event.method);
      });
    });
    const completed = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("turn completion timeout")), 1_000);
      client.onTurnCompleted((event) => {
        clearTimeout(timer);
        resolve(event.turn.id as string);
      });
    });

    const resumed = await client.resumeThread("thread-fake-1");
    assert.equal(resumed.id, "thread-fake-1");
    const turn = await client.startTurn({
      threadId: "thread-fake-1",
      prompt: "Continue safely",
      clientUserMessageId: "resume-key",
    });
    assert.equal(turn.id, "turn-auto");
    assert.equal(await requestSeen, "item/commandExecution/requestApproval");
    assert.equal(await completed, "turn-auto");

    const messages = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; line?: string })
      .filter((entry) => entry.type === "stdin")
      .map((entry) => JSON.parse(entry.line ?? "{}") as Record<string, unknown>);
    assert.deepEqual(
      messages.find((message) => message.id === "approval-9001")?.error,
      {
        code: -32601,
        message:
          "Unattended guardian cannot handle server request: item/commandExecution/requestApproval",
      },
    );
    const start = messages.find((message) => message.method === "turn/start");
    assert.deepEqual(start?.params, {
      threadId: "thread-fake-1",
      clientUserMessageId: "resume-key",
      input: [
        {
          type: "text",
          text: "Continue safely",
          text_elements: [],
        },
      ],
      outputSchema: RESUME_OUTPUT_SCHEMA,
    });
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
