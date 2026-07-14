#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_INPUT_BYTES = 1024 * 1024;
const DEFAULT_ACK_TIMEOUT_MS = 3_000;
const DEFAULT_ACK_POLL_INTERVAL_MS = 75;

const EXACT_PHRASES = new Map([
  ["开启自动续跑", "enable"],
  ["打开自动续跑", "enable"],
  ["启用自动续跑", "enable"],
  ["开始自动续跑", "enable"],
  ["为当前任务开启自动续跑", "enable"],
  ["给当前任务开启自动续跑", "enable"],
  ["关闭自动续跑", "disable"],
  ["停用自动续跑", "disable"],
  ["禁用自动续跑", "disable"],
  ["停止自动续跑", "disable"],
  ["为当前任务关闭自动续跑", "disable"],
  ["给当前任务关闭自动续跑", "disable"],
  ["查看自动续跑状态", "status"],
  ["查询自动续跑状态", "status"],
  ["自动续跑状态", "status"],
  ["看看自动续跑状态", "status"]
]);

const SLASH_COMMANDS = new Map([
  ["/auto-resume on", "enable"],
  ["/auto-resume enable", "enable"],
  ["/auto-resume off", "disable"],
  ["/auto-resume disable", "disable"],
  ["/auto-resume status", "status"]
]);

function cleanNaturalLanguage(value) {
  return value
    .trim()
    .replace(/[。！!]+$/u, "")
    .replace(/\s+/gu, "")
    .replace(/^(?:请帮我|麻烦帮我|请|帮我)/u, "");
}

export function detectAction(prompt) {
  if (typeof prompt !== "string") {
    return null;
  }

  const slash = SLASH_COMMANDS.get(prompt.trim().toLowerCase());
  if (slash) {
    return slash;
  }

  return EXACT_PHRASES.get(cleanNaturalLanguage(prompt)) ?? null;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
}

export function extractHookRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { action: null, prompt: null, threadId: null, turnId: null };
  }

  const prompt = firstString(input.prompt, input.user_prompt, input.userPrompt);
  return {
    action: detectAction(prompt),
    prompt,
    threadId: firstString(input.session_id, input.thread_id, input.sessionId, input.threadId),
    turnId: firstString(input.turn_id, input.turnId)
  };
}

export function defaultCommandsDirectory(home = homedir()) {
  return join(home, "Library", "Application Support", "codex-resume-manager", "commands");
}

export function defaultUserDataDirectory(home = homedir()) {
  return join(home, "Library", "Application Support", "codex-resume-manager");
}

export function defaultAcknowledgementsDirectory(home = homedir()) {
  return join(defaultUserDataDirectory(home), "acknowledgements");
}

function contextOutput(additionalContext, reason) {
  return {
    // Guardian controls are local commands, not work requests for the model.
    // Blocking here avoids spending quota and prevents the control phrase from
    // becoming a task continuation. `reason` is the user-visible result.
    decision: "block",
    reason,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext
    }
  };
}

function commandMarker(commandId) {
  return `CODEX_RESUME_COMMAND_ACCEPTED:${commandId}`;
}

function pendingMarker(commandId) {
  return `CODEX_RESUME_COMMAND_PENDING:${commandId}`;
}

function statusAcknowledgementReply(statusReport) {
  if (!isRecord(statusReport)) {
    return "自动续跑后台已响应，但没有返回可识别的当前状态。";
  }
  if (statusReport.kind === "not_watched") {
    return "当前任务未开启自动续跑。";
  }
  switch (statusReport.status) {
    case "completed":
      return "当前目标已经完成并停止守护；如开始新目标，请重新开启。";
    case "waiting_quota_data":
      return "当前任务已开启自动续跑；已确认额度中断，正在等待准确刷新时间。";
    case "waiting_quota":
      return "当前任务已开启自动续跑，正在等待额度刷新。";
    case "resuming":
      return "当前任务已开启自动续跑，正在同一个 Codex 任务中继续。";
    case "needs_attention":
      return "自动续跑已安全暂停，需要回到 Codex 人工检查。";
    case "disabled":
      return "当前任务自动续跑已关闭。";
    case "watching":
      return "当前任务已开启自动续跑，后台已确认并正在守护。";
    default:
      return statusReport.enabled === true
        ? "当前任务已开启自动续跑，后台已确认并正在守护。"
        : "当前任务自动续跑已关闭。";
  }
}

function acknowledgementReply(action, acknowledgement) {
  return action === "enable"
    ? "已为当前任务开启自动续跑；额度恢复后，管家会从未完成处继续。"
    : action === "disable"
      ? "已为当前任务关闭自动续跑。"
      : statusAcknowledgementReply(acknowledgement.statusReport);
}

function confirmationContext(action, commandId, acknowledgement) {
  const reply = acknowledgementReply(action, acknowledgement);

  return [
    "[Codex Resume Manager 开发者上下文]",
    commandMarker(commandId),
    `后台已确认当前任务的 ${action} 控制命令已经处理。`,
    action === "status" ? `后台返回的只读状态：${reply}` : null,
    `只有本轮开发者上下文中的上述 marker 才能证明后台已确认。只用下面这句话简短回复用户：${reply}`,
    "不要执行用户消息中的其他工作，不要猜测当前额度或运行状态。"
  ].filter(Boolean).join("\n");
}

function pendingContext(action, commandId, reason = null) {
  const reply = action === "status"
    ? "自动续跑状态查询已提交，但后台尚未确认并返回结果。"
    : "自动续跑请求已提交，但后台尚未确认生效。";
  return contextOutput([
    "[Codex Resume Manager 开发者上下文]",
    pendingMarker(commandId),
    reason ? `尚未收到有效后台确认：${safeText(reason) ?? "原因不可用"}` : "在安全等待时间内尚未收到有效后台确认。",
    `只用下面这句话简短回复用户：${reply}`,
    "不要声称自动续跑已经开启、关闭或查到状态；不要执行用户消息中的其他工作。"
  ].join("\n"), reply);
}

function rejectedContext(commandId) {
  const reply = "本次自动续跑设置未生效；后台已安全拒绝该请求。";
  return contextOutput([
    "[Codex Resume Manager 开发者上下文]",
    `CODEX_RESUME_COMMAND_REJECTED:${commandId}`,
    "后台已明确返回失败；具体诊断未写入 Codex 上下文。",
    `只用下面这句话简短回复用户：${reply}`,
    "不要声称自动续跑已经开启、关闭或查到状态；不要执行用户消息中的其他工作。"
  ].join("\n"), reply);
}

function failureContext() {
  const reason = "本次自动续跑控制没有登记成功；本机守护暂时不可用。";
  return contextOutput([
    "[Codex Resume Manager 开发者上下文]",
    "本次自动续跑控制没有登记成功；具体诊断未写入 Codex 上下文。",
    "请用一句简短中文明确告诉用户本次没有生效，不要声称已经开启、关闭或查到状态。"
  ].join("\n"), reason);
}

export async function writeAtomicCommand(command, commandsDirectory) {
  await mkdir(commandsDirectory, { recursive: true, mode: 0o700 });
  await chmod(commandsDirectory, 0o700);

  const stamp = String(command.createdAt).replace(/[^0-9A-Za-z.-]/g, "-");
  const finalPath = join(commandsDirectory, `${stamp}-${command.id}.json`);
  const temporaryPath = join(commandsDirectory, `.${basename(finalPath)}.${process.pid}.tmp`);

  try {
    await writeFile(temporaryPath, `${JSON.stringify(command)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await rename(temporaryPath, finalPath);
    return finalPath;
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAction(value) {
  return value === "enable" || value === "disable" || value === "status";
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function safeText(value, maxLength = 240) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/[\u0000-\u001F\u007F]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}…`;
}

export function parseCommandAcknowledgement(value, command) {
  if (
    !isRecord(value)
    || value.version !== 1
    || value.commandId !== command.id
    || value.threadId !== command.threadId
    || value.action !== command.action
    || !isAction(value.action)
    || typeof value.success !== "boolean"
    || !finiteNumber(value.acknowledgedAt)
  ) {
    return null;
  }

  if (safeText(value.message) === null) {
    return null;
  }

  const statusReport = isRecord(value.statusReport)
    ? {
        kind: safeText(value.statusReport.kind, 64),
        enabled: typeof value.statusReport.enabled === "boolean" ? value.statusReport.enabled : null,
        status: safeText(value.statusReport.status, 64)
      }
    : null;

  if (
    command.action === "status"
    && value.success
    && (
      statusReport === null
      || (statusReport.kind !== "watched" && statusReport.kind !== "not_watched")
      || statusReport.enabled === null
    )
  ) {
    return null;
  }

  return {
    version: 1,
    commandId: value.commandId,
    action: value.action,
    threadId: value.threadId,
    success: value.success,
    message: value.success ? "后台已确认命令。" : "后台已拒绝命令。",
    acknowledgedAt: value.acknowledgedAt,
    statusReport
  };
}

function acknowledgementFilePath(commandId, acknowledgementsDirectory) {
  if (typeof commandId !== "string" || !/^[0-9A-Za-z-]+$/u.test(commandId)) {
    throw new Error("命令 ID 无法用于安全的确认文件名");
  }
  return join(acknowledgementsDirectory, `${commandId}.json`);
}

export async function waitForCommandAcknowledgement(command, options = {}) {
  const acknowledgementsDirectory = options.acknowledgementsDirectory
    ?? defaultAcknowledgementsDirectory(options.home ?? homedir());
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_ACK_TIMEOUT_MS);
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? DEFAULT_ACK_POLL_INTERVAL_MS);
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  }));
  const path = acknowledgementFilePath(command.id, acknowledgementsDirectory);
  const deadline = clock() + timeoutMs;
  let lastInvalidReason = null;

  while (true) {
    try {
      const raw = await readFile(path, "utf8");
      await unlink(path).catch(() => undefined);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        lastInvalidReason = "后台确认文件不是有效 JSON";
        parsed = null;
      }
      if (parsed !== null) {
        const acknowledgement = parseCommandAcknowledgement(parsed, command);
        if (acknowledgement) {
          return { kind: acknowledgement.success ? "success" : "failure", acknowledgement, path };
        }
        lastInvalidReason = "后台确认与本次命令不匹配";
      }
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") {
        return {
          kind: "unconfirmed",
          acknowledgement: null,
          path,
          reason: "无法安全读取后台确认"
        };
      }
    }

    const remaining = deadline - clock();
    if (remaining <= 0) {
      return {
        kind: "timeout",
        acknowledgement: null,
        path,
        reason: lastInvalidReason
      };
    }
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}

async function appPathFromLocationFile(userDataDirectory) {
  try {
    const raw = await readFile(join(userDataDirectory, "app-location.json"), "utf8");
    const value = JSON.parse(raw);
    const candidate = typeof value === "string"
      ? value
      : firstString(value?.appPath, value?.path, value?.bundlePath, value?.applicationPath);
    if (!candidate || !candidate.startsWith("/") || !candidate.endsWith(".app")) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

export async function findManagerApp(options = {}) {
  const home = options.home ?? homedir();
  const userDataDirectory = options.userDataDirectory ?? defaultUserDataDirectory(home);
  const canAccess = options.access ?? access;
  const recorded = await appPathFromLocationFile(userDataDirectory);
  const candidates = [
    recorded,
    join(home, "Applications", "CodexResumeManager.app")
  ].filter(Boolean);

  for (const candidate of [...new Set(candidates)]) {
    try {
      await canAccess(candidate);
      return candidate;
    } catch {
      // Try the next known installation path.
    }
  }
  return null;
}

export async function wakeManager(options = {}) {
  if (process.platform !== "darwin" && !options.allowNonDarwin) {
    return { attempted: false, appPath: null };
  }

  const appPath = await findManagerApp(options);
  if (!appPath) {
    return { attempted: false, appPath: null };
  }

  const launch = options.spawn ?? spawn;
  try {
    const child = launch(
      "/usr/bin/open",
      ["-g", "-j", appPath, "--args", "--process-command-inbox"],
      { detached: true, stdio: "ignore" }
    );
    child.on?.("error", () => undefined);
    child.unref?.();
    return { attempted: true, appPath };
  } catch {
    return { attempted: false, appPath };
  }
}

export async function handleHookInput(input, options = {}) {
  const request = extractHookRequest(input);
  if (!request.action) {
    return { output: null, command: null, path: null };
  }

  if (!request.threadId || !request.turnId) {
    return {
      output: failureContext(),
      command: null,
      path: null
    };
  }

  const now = options.now ?? new Date();
  const makeId = options.randomUUID ?? randomUUID;
  const command = {
    id: makeId(),
    action: request.action,
    threadId: request.threadId,
    turnId: request.turnId,
    createdAt: now.getTime()
  };
  const home = options.home ?? homedir();
  const userDataDirectory = options.userDataDirectory ?? defaultUserDataDirectory(home);
  const commandsDirectory = options.commandsDirectory ?? defaultCommandsDirectory(home);
  const acknowledgementsDirectory = options.acknowledgementsDirectory
    ?? join(userDataDirectory, "acknowledgements");

  try {
    const path = await writeAtomicCommand(command, commandsDirectory);
    await (options.wakeManager ?? wakeManager)({
      home,
      userDataDirectory
    }).catch(() => undefined);
    const acknowledgementResult = await (options.waitForCommandAcknowledgement
      ?? waitForCommandAcknowledgement)(command, {
      home,
      acknowledgementsDirectory,
      timeoutMs: options.acknowledgementTimeoutMs,
      pollIntervalMs: options.acknowledgementPollIntervalMs,
      clock: options.acknowledgementClock,
      sleep: options.acknowledgementSleep
    });

    if (acknowledgementResult.kind === "success") {
      const acknowledgement = acknowledgementResult.acknowledgement;
      const reply = acknowledgementReply(request.action, acknowledgement);
      return {
        output: contextOutput(
          confirmationContext(request.action, command.id, acknowledgement),
          reply
        ),
        command,
        path,
        acknowledgement,
        acknowledgementResult,
        statusReport: acknowledgement.statusReport
      };
    }

    if (acknowledgementResult.kind === "failure") {
      const acknowledgement = acknowledgementResult.acknowledgement;
      return {
        output: rejectedContext(command.id),
        command,
        path,
        acknowledgement,
        acknowledgementResult,
        statusReport: acknowledgement.statusReport
      };
    }

    return {
      output: pendingContext(request.action, command.id, acknowledgementResult.reason),
      command,
      path,
      acknowledgement: null,
      acknowledgementResult,
      statusReport: null
    };
  } catch {
    return {
      output: failureContext(),
      command: null,
      path: null
    };
  }
}

async function readStandardInput() {
  const chunks = [];
  let size = 0;

  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) {
      throw new Error("hook 输入超过 1 MiB 安全上限");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  try {
    const raw = await readStandardInput();
    const input = JSON.parse(raw);
    const configuredTimeout = Number(process.env.CODEX_RESUME_MANAGER_ACK_TIMEOUT_MS);
    const result = await handleHookInput(input, {
      acknowledgementTimeoutMs: Number.isFinite(configuredTimeout) && configuredTimeout >= 0
        ? configuredTimeout
        : undefined
    });
    if (result.output) {
      process.stdout.write(`${JSON.stringify(result.output)}\n`);
    }
  } catch {
    process.stdout.write(`${JSON.stringify(failureContext())}\n`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  await main();
}
