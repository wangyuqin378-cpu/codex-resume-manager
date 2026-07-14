import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const scenario = process.env.FAKE_CODEX_SCENARIO ?? "success";
const tracePath = process.env.FAKE_CODEX_TRACE;

if (tracePath) {
  appendFileSync(tracePath, `${JSON.stringify({ type: "argv", args })}\n`);
}

if (args.includes("--version")) {
  process.stdout.write("codex-cli 9.9.9-fake\n");
} else if (args.includes("app-server")) {
  runAppServer();
} else {
  runExec();
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function runExec() {
  const resumeIndex = args.indexOf("resume");
  const isResume = resumeIndex >= 0;
  const resumedThreadId = isResume
    ? args[args.indexOf("--output-schema", resumeIndex) + 2]
    : null;
  const threadId = resumedThreadId || "thread-fake-1";

  emit({ type: "thread.started", thread_id: threadId });
  emit({ type: "turn.started", turn_id: isResume ? "turn-resume" : "turn-new" });

  if (scenario === "wait") {
    process.on("SIGTERM", () => process.exit(143));
    setInterval(() => undefined, 1_000);
    return;
  }

  if (scenario === "quota" || scenario === "quota-zero") {
    emit({
      type: "turn.failed",
      turn_id: "turn-quota",
      error: {
        message: "Usage limit reached",
        codexErrorInfo: "UsageLimitExceeded",
      },
    });
    process.exitCode = scenario === "quota" ? 9 : 0;
    return;
  }

  if (scenario === "nested-quota") {
    emit({
      type: "item.completed",
      item: {
        id: "subagent-error",
        type: "error",
        codexErrorInfo: "UsageLimitExceeded",
        message: "A subagent hit its limit",
      },
    });
    process.exitCode = 7;
    return;
  }

  const text =
    scenario === "invalid-output"
      ? "not structured output"
      : JSON.stringify({
          status: "complete",
          message: isResume ? "resumed" : "done",
          verification: "tests passed",
        });
  emit({
    type: "item.completed",
    item: { id: "final", type: "agent_message", text },
  });
  emit({
    type: "turn.completed",
    usage: {
      input_tokens: 10,
      cached_input_tokens: 2,
      output_tokens: 3,
      reasoning_output_tokens: 1,
    },
  });
}

function runAppServer() {
  let initialized = false;
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (tracePath) {
      appendFileSync(tracePath, `${JSON.stringify({ type: "stdin", line })}\n`);
    }
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      emit({
        id: request.id,
        result: {
          userAgent: "fake-codex",
          codexHome: "/tmp/fake-codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      });
      return;
    }
    if (request.method === "initialized") {
      initialized = true;
      return;
    }
    if (!initialized) {
      emit({ id: request.id, error: { code: -32002, message: "Not initialized" } });
      return;
    }
    if (request.method === "account/rateLimits/read") {
      emit({
        id: request.id,
        result: {
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: {
              usedPercent: 25,
              windowDurationMins: 300,
              resetsAt: 1_800_000_000,
            },
            secondary: {
              usedPercent: 40,
              windowDurationMins: 10_080,
              resetsAt: 1_800_500_000,
            },
            rateLimitReachedType: null,
          },
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              limitName: "Codex",
              primary: {
                usedPercent: 25,
                windowDurationMins: 300,
                resetsAt: 1_800_000_000,
              },
              secondary: {
                usedPercent: 40,
                windowDurationMins: 10_080,
                resetsAt: 1_800_500_000,
              },
              rateLimitReachedType: null,
            },
          },
        },
      });
      setTimeout(() => {
        emit({
          method: "account/rateLimits/updated",
          params: { rateLimits: { primary: { usedPercent: 60 } } },
        });
      }, 10);
      return;
    }
    if (request.method === "thread/read") {
      emit({
        id: request.id,
        result: {
          thread: {
            id: request.params.threadId,
            status: { type: "notLoaded" },
            turns: [{ id: "turn-fake-last", status: "failed", items: [] }],
          },
        },
      });
      return;
    }
    if (request.method === "thread/resume") {
      emit({
        id: request.id,
        result: {
          thread: {
            id: request.params.threadId,
            cwd: "/tmp/fake-project",
            parentThreadId: null,
            status: { type: "idle" },
            turns: [
              {
                id: "turn-fake-last",
                status: "failed",
                error: { codexErrorInfo: "usageLimitExceeded" },
                items: [],
              },
            ],
          },
        },
      });
      return;
    }
    if (request.method === "thread/goal/get") {
      emit({
        id: request.id,
        result: {
          goal:
            request.params.threadId === "thread-without-goal"
              ? null
              : {
                  objective: "Finish the fake project",
                  status: "active",
                },
        },
      });
      return;
    }
    if (request.method === "hooks/list") {
      emit({
        id: request.id,
        result: {
          data: [
            {
              id: "codex-auto-resume",
              scope: "user",
              status: "trusted",
            },
          ],
        },
      });
      return;
    }
    if (request.method === "turn/start") {
      emit({
        id: request.id,
        result: {
          turn: { id: "turn-auto", status: "inProgress", error: null, items: [] },
        },
      });
      setTimeout(() => {
        emit({
          id: "approval-9001",
          method: "item/commandExecution/requestApproval",
          params: { threadId: request.params.threadId },
        });
      }, 5);
      return;
    }
    if (request.id === "approval-9001" && request.error) {
      setTimeout(() => {
        emit({
          method: "turn/completed",
          params: {
            threadId: "thread-fake-1",
            turn: { id: "turn-auto", status: "failed", error: null, items: [] },
          },
        });
      }, 5);
      return;
    }
    emit({ id: request.id, error: { code: -32601, message: "Method not found" } });
  });

  process.on("SIGTERM", () => process.exit(0));
}
