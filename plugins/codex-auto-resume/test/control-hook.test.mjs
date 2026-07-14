import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  defaultCommandsDirectory,
  defaultAcknowledgementsDirectory,
  defaultUserDataDirectory,
  detectAction,
  extractHookRequest,
  findManagerApp,
  handleHookInput,
  parseCommandAcknowledgement,
  waitForCommandAcknowledgement,
  wakeManager
} from "../scripts/control-hook.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, "../scripts/control-hook.mjs");
const repositoryRoot = resolve(here, "../../..");

async function writeAcknowledgement(directory, command, overrides = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const acknowledgement = {
    version: 1,
    commandId: command.id,
    action: command.action,
    threadId: command.threadId,
    success: true,
    message: "后台已应用命令",
    acknowledgedAt: 1_783_911_846_000,
    ...overrides
  };
  await writeFile(
    join(directory, `${command.id}.json`),
    `${JSON.stringify(acknowledgement)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  return acknowledgement;
}

function assertBlockedUserResult(output, expectedReason) {
  assert.equal(output.decision, "block");
  assert.equal(output.reason, expectedReason);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(typeof output.hookSpecificOutput.additionalContext, "string");
  assert.notEqual(output.reason, output.hookSpecificOutput.additionalContext);
}

test("marketplace declares the install and authentication policy", async () => {
  const marketplace = JSON.parse(
    await readFile(join(repositoryRoot, ".agents/plugins/marketplace.json"), "utf8")
  );
  const entry = marketplace.plugins.find((plugin) => plugin.name === "codex-auto-resume");
  assert.deepEqual(entry.source, {
    source: "local",
    path: "./plugins/codex-auto-resume"
  });
  assert.deepEqual(entry.policy, {
    installation: "AVAILABLE",
    authentication: "ON_USE"
  });
});

test("plugin and skill keep the acknowledged marker-gated contract", async () => {
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, "plugins/codex-auto-resume/.codex-plugin/plugin.json"), "utf8")
  );
  assert.equal(manifest.version, "0.3.0");

  const skill = await readFile(
    join(repositoryRoot, "plugins/codex-auto-resume/skills/codex-auto-resume/SKILL.md"),
    "utf8"
  );
  assert.match(skill, /CODEX_RESUME_COMMAND_ACCEPTED:<command id>/u);
  assert.match(skill, /CODEX_RESUME_COMMAND_PENDING:<command id>/u);
  assert.match(skill, /\/hooks/u);
  assert.doesNotMatch(skill, /## 推荐确认文案/u);
  assert.doesNotMatch(skill, /已为当前任务提交自动续跑设置/u);
});

test("detectAction recognizes explicit Chinese and slash controls", () => {
  assert.equal(detectAction("开启自动续跑"), "enable");
  assert.equal(detectAction("请帮我打开自动续跑！"), "enable");
  assert.equal(detectAction("为当前任务关闭自动续跑"), "disable");
  assert.equal(detectAction("看看自动续跑状态"), "status");
  assert.equal(detectAction("/auto-resume ON"), "enable");
  assert.equal(detectAction("/auto-resume status"), "status");
});

test("detectAction rejects discussion, questions, and mixed work requests", () => {
  assert.equal(detectAction("我想做一个自动续跑产品"), null);
  assert.equal(detectAction("怎么开启自动续跑？"), null);
  assert.equal(detectAction("开启自动续跑，然后帮我重构项目"), null);
  assert.equal(detectAction("额度恢复后是否会自动续跑"), null);
});

test("every recognized control result blocks model execution with the real user reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-auto-resume-block-"));
  const actions = [
    {
      action: "enable",
      prompt: "开启自动续跑",
      successReply: "已为当前任务开启自动续跑；额度恢复后，管家会从未完成处继续。",
      pendingReply: "自动续跑请求已提交，但后台尚未确认生效。"
    },
    {
      action: "disable",
      prompt: "关闭自动续跑",
      successReply: "已为当前任务关闭自动续跑。",
      pendingReply: "自动续跑请求已提交，但后台尚未确认生效。"
    },
    {
      action: "status",
      prompt: "查看自动续跑状态",
      successReply: "当前任务已开启自动续跑，后台已确认并正在守护。",
      pendingReply: "自动续跑状态查询已提交，但后台尚未确认并返回结果。"
    }
  ];
  let sequence = 1;

  for (const entry of actions) {
    for (const outcome of ["success", "pending", "rejected", "failure"]) {
      const commandId = `control-${entry.action}-${outcome}-${sequence++}`;
      const rejectedMessage = `后台拒绝 ${entry.action}：/Users/private/internal-state.json`;
      const waitForCommandAcknowledgement = async (command) => {
        if (outcome === "failure") {
          throw new Error(`确认通道故障 ${entry.action}：/Users/private/internal-state.json`);
        }
        if (outcome === "pending") {
          return {
            kind: "timeout",
            acknowledgement: null,
            path: join(root, "acknowledgements", `${command.id}.json`),
            reason: null
          };
        }
        const success = outcome === "success";
        return {
          kind: success ? "success" : "failure",
          acknowledgement: {
            version: 1,
            commandId: command.id,
            action: command.action,
            threadId: command.threadId,
            success,
            message: success ? "后台已应用命令" : rejectedMessage,
            acknowledgedAt: 1_000,
            statusReport: entry.action === "status" && success
              ? {
                  kind: "watched",
                  enabled: true,
                  status: "watching",
                  reply: "不可信自由文本：/Users/private/internal-project"
                }
              : null
          },
          path: join(root, "acknowledgements", `${command.id}.json`)
        };
      };
      const result = await handleHookInput(
        {
          prompt: entry.prompt,
          session_id: "thread-control",
          turn_id: `turn-${commandId}`,
          cwd: "/tmp/project"
        },
        {
          commandsDirectory: join(root, "commands"),
          acknowledgementsDirectory: join(root, "acknowledgements"),
          randomUUID: () => commandId,
          wakeManager: async () => ({ attempted: true, appPath: "/tmp/manager.app" }),
          waitForCommandAcknowledgement
        }
      );

      const expectedReason = outcome === "success"
        ? entry.successReply
        : outcome === "pending"
          ? entry.pendingReply
          : outcome === "rejected"
            ? "本次自动续跑设置未生效；后台已安全拒绝该请求。"
            : "本次自动续跑控制没有登记成功；本机守护暂时不可用。";
      assertBlockedUserResult(result.output, expectedReason);
      const renderedOutput = JSON.stringify(result.output);
      assert.doesNotMatch(renderedOutput, /\/Users\/private/u);
      assert.doesNotMatch(renderedOutput, /internal-state|internal-project/u);
      assert.doesNotMatch(renderedOutput, /确认通道故障/u);
    }
  }
});

test("extractHookRequest supports Codex snake_case metadata", () => {
  assert.deepEqual(
    extractHookRequest({
      prompt: "开启自动续跑",
      session_id: "thread-1",
      turn_id: "turn-1",
      cwd: "/tmp/project"
    }),
    {
      action: "enable",
      prompt: "开启自动续跑",
      threadId: "thread-1",
      turnId: "turn-1"
    }
  );
});

test("handleHookInput only reports success after a matching manager acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-auto-resume-hook-"));
  const commandsDirectory = join(root, "commands");
  const acknowledgementsDirectory = join(root, "acknowledgements");
  const expectedCommand = {
    id: "00000000-0000-4000-8000-000000000001",
    action: "enable",
    threadId: "thread-1"
  };
  const result = await handleHookInput(
    {
      prompt: "开启自动续跑",
      session_id: "thread-1",
      turn_id: "turn-1",
      cwd: "/tmp/project"
    },
    {
      commandsDirectory,
      acknowledgementsDirectory,
      now: new Date("2026-07-13T03:04:05.000Z"),
      randomUUID: () => expectedCommand.id,
      wakeManager: async () => {
        await writeAcknowledgement(acknowledgementsDirectory, expectedCommand);
        return { attempted: true, appPath: "/tmp/CodexResumeManager.app" };
      }
    }
  );

  assert.deepEqual(result.command, {
    id: "00000000-0000-4000-8000-000000000001",
    action: "enable",
    threadId: "thread-1",
    turnId: "turn-1",
    createdAt: 1783911845000
  });
  assert.match(
    result.output.hookSpecificOutput.additionalContext,
    /CODEX_RESUME_COMMAND_ACCEPTED:00000000-0000-4000-8000-000000000001/u
  );
  assert.match(result.output.hookSpecificOutput.additionalContext, /只用下面这句话简短回复用户/u);
  assert.match(result.output.hookSpecificOutput.additionalContext, /已为当前任务开启自动续跑/u);
  assert.equal(result.acknowledgement.success, true);

  const files = await readdir(commandsDirectory);
  assert.equal(files.length, 1);
  assert.equal(files.some((name) => name.endsWith(".tmp")), false);
  assert.deepEqual(JSON.parse(await readFile(result.path, "utf8")), result.command);
  assert.equal((await stat(commandsDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(acknowledgementsDirectory), []);
});

test("timeout reports submitted but unconfirmed and never emits the accepted marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-auto-resume-hook-"));
  const result = await handleHookInput(
    {
      prompt: "开启自动续跑",
      session_id: "thread-1",
      turn_id: "turn-1",
      cwd: "/tmp/project"
    },
    {
      commandsDirectory: join(root, "commands"),
      acknowledgementsDirectory: join(root, "acknowledgements"),
      acknowledgementTimeoutMs: 0,
      randomUUID: () => "00000000-0000-4000-8000-000000000010",
      wakeManager: async () => ({ attempted: false, appPath: null })
    }
  );

  assert.equal(result.acknowledgementResult.kind, "timeout");
  assert.match(result.output.hookSpecificOutput.additionalContext, /CODEX_RESUME_COMMAND_PENDING:/u);
  assert.match(result.output.hookSpecificOutput.additionalContext, /已提交，但后台尚未确认生效/u);
  assert.doesNotMatch(result.output.hookSpecificOutput.additionalContext, /CODEX_RESUME_COMMAND_ACCEPTED:/u);
  assert.doesNotMatch(result.output.hookSpecificOutput.additionalContext, /已为当前任务开启/u);
});

test("explicit failure acknowledgement says the change did not take effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-auto-resume-hook-"));
  const acknowledgementsDirectory = join(root, "acknowledgements");
  const expectedCommand = {
    id: "00000000-0000-4000-8000-000000000011",
    action: "disable",
    threadId: "thread-1"
  };
  const result = await handleHookInput(
    {
      prompt: "关闭自动续跑",
      session_id: "thread-1",
      turn_id: "turn-1",
      cwd: "/tmp/project"
    },
    {
      commandsDirectory: join(root, "commands"),
      acknowledgementsDirectory,
      randomUUID: () => expectedCommand.id,
      wakeManager: async () => {
        await writeAcknowledgement(acknowledgementsDirectory, expectedCommand, {
          success: false,
          message: "后台状态保存失败：/Users/private/internal-state.json"
        });
        return { attempted: true, appPath: "/tmp/CodexResumeManager.app" };
      }
    }
  );

  assert.equal(result.acknowledgementResult.kind, "failure");
  assert.equal(result.acknowledgement.message, "后台已拒绝命令。");
  assert.equal(result.output.reason, "本次自动续跑设置未生效；后台已安全拒绝该请求。");
  assert.match(result.output.hookSpecificOutput.additionalContext, /CODEX_RESUME_COMMAND_REJECTED:/u);
  assert.match(result.output.hookSpecificOutput.additionalContext, /具体诊断未写入 Codex 上下文/u);
  assert.doesNotMatch(result.output.hookSpecificOutput.additionalContext, /CODEX_RESUME_COMMAND_ACCEPTED:/u);
  assert.doesNotMatch(JSON.stringify(result.output), /后台状态保存失败|\/Users\/private|internal-state/u);
  assert.deepEqual(await readdir(acknowledgementsDirectory), []);
});

test("mismatched acknowledgement is discarded and cannot prove success", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-auto-resume-hook-"));
  const acknowledgementsDirectory = join(root, "acknowledgements");
  const command = {
    id: "00000000-0000-4000-8000-000000000012",
    action: "enable",
    threadId: "thread-1"
  };
  await writeAcknowledgement(acknowledgementsDirectory, command, { threadId: "another-thread" });

  const result = await waitForCommandAcknowledgement(command, {
    acknowledgementsDirectory,
    timeoutMs: 0
  });
  assert.equal(result.kind, "timeout");
  assert.match(result.reason, /不匹配/u);
  assert.deepEqual(await readdir(acknowledgementsDirectory), []);
});

test("status acknowledgement trusts only structured state and drops free-form text", () => {
  const command = { id: "command-1", action: "status", threadId: "thread-1" };
  const base = {
    version: 1,
    commandId: command.id,
    action: command.action,
    threadId: command.threadId,
    success: true,
    message: "已读取状态：/Users/private/internal-state.json",
    acknowledgedAt: 1_000
  };
  assert.equal(parseCommandAcknowledgement(base, command), null);
  const parsed = parseCommandAcknowledgement({
    ...base,
    statusReport: {
      kind: "watched",
      enabled: true,
      status: "watching",
      reply: "不可信自由文本：/Users/private/internal-project"
    }
  }, command);
  assert.deepEqual(parsed?.statusReport, {
    kind: "watched",
    enabled: true,
    status: "watching"
  });
  assert.equal(parsed?.message, "后台已确认命令。");
  assert.doesNotMatch(JSON.stringify(parsed), /\/Users\/private|internal-project|internal-state/u);
});

test("acknowledgement identity validates command id, action, and thread id", () => {
  const command = { id: "command-identity", action: "enable", threadId: "thread-identity" };
  const acknowledgement = {
    version: 1,
    commandId: command.id,
    action: command.action,
    threadId: command.threadId,
    success: true,
    message: "已开启",
    acknowledgedAt: 1_000
  };
  assert.equal(parseCommandAcknowledgement(acknowledgement, command)?.success, true);
  assert.equal(parseCommandAcknowledgement({ ...acknowledgement, commandId: "other" }, command), null);
  assert.equal(parseCommandAcknowledgement({ ...acknowledgement, action: "disable" }, command), null);
  assert.equal(parseCommandAcknowledgement({ ...acknowledgement, threadId: "other" }, command), null);
});

test("missing task metadata fails closed and writes no command", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-auto-resume-hook-"));
  const commandsDirectory = join(root, "commands");
  const result = await handleHookInput(
    { prompt: "关闭自动续跑", session_id: "thread-1", cwd: "/tmp/project" },
    { commandsDirectory }
  );

  assert.equal(result.command, null);
  assert.match(result.output.hookSpecificOutput.additionalContext, /没有登记成功/);
  assert.doesNotMatch(result.output.hookSpecificOutput.additionalContext, /CODEX_RESUME_COMMAND_ACCEPTED/u);
  await assert.rejects(readdir(commandsDirectory), { code: "ENOENT" });
});

test("command write failures expose only a generic message", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-auto-resume-private-error-"));
  const privateDirectory = join(root, "Users", "private");
  await mkdir(privateDirectory, { recursive: true });
  const commandsDirectory = join(privateDirectory, "commands");
  await writeFile(commandsDirectory, "force mkdir failure", "utf8");

  const result = await handleHookInput(
    {
      prompt: "开启自动续跑",
      session_id: "thread-private",
      turn_id: "turn-private",
      cwd: "/Users/private/internal-project"
    },
    {
      commandsDirectory,
      randomUUID: () => "private-write-failure"
    }
  );

  assert.equal(result.command, null);
  assert.equal(result.output.reason, "本次自动续跑控制没有登记成功；本机守护暂时不可用。");
  assert.match(result.output.hookSpecificOutput.additionalContext, /具体诊断未写入 Codex 上下文/u);
  assert.doesNotMatch(
    JSON.stringify(result.output),
    /\/Users\/private|internal-project|private-write-failure|EEXIST|commands/u
  );
});

test("status command uses structured state and never exposes free-form acknowledgement text", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-auto-resume-status-"));
  const userDataDirectory = join(root, "user-data");
  const commandsDirectory = join(userDataDirectory, "commands");
  const acknowledgementsDirectory = join(userDataDirectory, "acknowledgements");
  let wakeCalls = 0;
  const result = await handleHookInput(
    {
      prompt: "查看自动续跑状态",
      session_id: "thread-live",
      turn_id: "turn-live",
      cwd: "/tmp/live-project"
    },
    {
      commandsDirectory,
      userDataDirectory,
      acknowledgementsDirectory,
      randomUUID: () => "00000000-0000-4000-8000-000000000002",
      wakeManager: async () => {
        wakeCalls += 1;
        await writeAcknowledgement(acknowledgementsDirectory, {
          id: "00000000-0000-4000-8000-000000000002",
          action: "status",
          threadId: "thread-live"
        }, {
          message: "已读取状态：/Users/private/internal-state.json",
          statusReport: {
            kind: "watched",
            enabled: true,
            status: "resuming",
            reply: "不可信自由文本：/Users/private/internal-project"
          }
        });
        return { attempted: true, appPath: "/tmp/CodexResumeManager.app" };
      }
    }
  );

  assert.equal(wakeCalls, 1);
  assert.equal(result.command.action, "status");
  assert.deepEqual(result.statusReport, {
    kind: "watched",
    enabled: true,
    status: "resuming"
  });
  assert.equal(result.acknowledgement.message, "后台已确认命令。");
  assert.match(result.output.hookSpecificOutput.additionalContext, /正在同一个 Codex 任务中继续/u);
  assert.match(
    result.output.hookSpecificOutput.additionalContext,
    /CODEX_RESUME_COMMAND_ACCEPTED:00000000-0000-4000-8000-000000000002/u
  );
  assert.doesNotMatch(
    JSON.stringify(result.output),
    /\/Users\/private|internal-state|internal-project|不可信自由文本/u
  );
});

test("unrelated prompts are silent and do not create the command directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-auto-resume-hook-"));
  const commandsDirectory = join(root, "commands");
  const result = await handleHookInput(
    {
      prompt: "继续完成原来的任务",
      session_id: "thread-1",
      turn_id: "turn-1",
      cwd: "/tmp/project"
    },
    { commandsDirectory }
  );

  assert.deepEqual(result, { output: null, command: null, path: null });
  await assert.rejects(readdir(commandsDirectory), { code: "ENOENT" });
});

test("the executable hook uses the lowercase Electron userData path", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-auto-resume-home-"));
  const input = {
    prompt: "/auto-resume status",
    session_id: "thread-live",
    turn_id: "turn-live",
    cwd: "/tmp/live-project"
  };
  const child = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, HOME: home, CODEX_RESUME_MANAGER_ACK_TIMEOUT_MS: "0" }
  });

  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /状态查询已提交，但后台尚未确认并返回结果/u);
  assert.match(output.hookSpecificOutput.additionalContext, /CODEX_RESUME_COMMAND_PENDING:/u);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /CODEX_RESUME_COMMAND_ACCEPTED:/u);

  const expectedDirectory = defaultCommandsDirectory(home);
  const files = await readdir(expectedDirectory);
  assert.equal(files.length, 1);
  const command = JSON.parse(await readFile(join(expectedDirectory, files[0]), "utf8"));
  assert.equal(command.action, "status");
  assert.equal(command.threadId, "thread-live");
  assert.equal(typeof command.createdAt, "number");
  assert.equal(defaultAcknowledgementsDirectory(home), join(defaultUserDataDirectory(home), "acknowledgements"));
});

test("findManagerApp prefers app-location.json and wakeManager launches hidden", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-auto-resume-home-"));
  const userDataDirectory = defaultUserDataDirectory(home);
  const recordedApp = join(home, "Custom", "CodexResumeManager.app");
  await mkdir(recordedApp, { recursive: true });
  await mkdir(userDataDirectory, { recursive: true });
  await writeFile(
    join(userDataDirectory, "app-location.json"),
    JSON.stringify({ appPath: recordedApp }),
    "utf8"
  );

  assert.equal(await findManagerApp({ home, userDataDirectory }), recordedApp);

  const launches = [];
  const result = await wakeManager({
    home,
    userDataDirectory,
    allowNonDarwin: true,
    spawn: (command, args, options) => {
      launches.push({ command, args, options });
      return { on() {}, unref() {} };
    }
  });

  assert.deepEqual(result, { attempted: true, appPath: recordedApp });
  assert.deepEqual(launches, [
    {
      command: "/usr/bin/open",
      args: ["-g", "-j", recordedApp, "--args", "--process-command-inbox"],
      options: { detached: true, stdio: "ignore" }
    }
  ]);
});

test("findManagerApp falls back to the user Applications directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-auto-resume-home-"));
  const fallback = join(home, "Applications", "CodexResumeManager.app");
  await mkdir(fallback, { recursive: true });
  assert.equal(await findManagerApp({ home }), fallback);
});

test("invalid JSON returns safe developer context instead of crashing", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-auto-resume-home-"));
  const privateInput = "not-json /Users/private/internal-project PRIVATE_DIAGNOSTIC";
  const child = spawnSync(process.execPath, [scriptPath], {
    input: privateInput,
    encoding: "utf8",
    env: { ...process.env, HOME: home }
  });

  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.equal(output.reason, "本次自动续跑控制没有登记成功；本机守护暂时不可用。");
  assert.match(output.hookSpecificOutput.additionalContext, /具体诊断未写入 Codex 上下文/u);
  assert.doesNotMatch(
    JSON.stringify(output),
    /not-json|\/Users\/private|internal-project|PRIVATE_DIAGNOSTIC/u
  );
});
