import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CommandInbox,
  parseGuardianCommand,
  type GuardianCommand,
  type CommandInboxFailure,
} from "../src/main/command-inbox.js";

const NOW = 1_000_000;

test("parses only bounded declarative guardian commands", () => {
  const command = parseGuardianCommand(JSON.stringify({
    id: "command-1",
    action: "enable",
    threadId: "thread-1",
    turnId: "turn-1",
    createdAt: NOW,
  }), NOW);

  assert.deepEqual(command, {
    id: "command-1",
    action: "enable",
    threadId: "thread-1",
    turnId: "turn-1",
    createdAt: NOW,
  });
  assert.equal(parseGuardianCommand("not json", NOW), null);
  assert.equal(parseGuardianCommand(JSON.stringify({
    id: "command-2",
    action: "execute",
    threadId: "thread-1",
    turnId: null,
    createdAt: NOW,
    command: "rm -rf /",
  }), NOW), null);
});

test("accepts command age boundaries and rejects expired or future commands", () => {
  const command = (createdAt: number): string => JSON.stringify({
    id: "command-time",
    action: "status",
    threadId: "thread-1",
    turnId: null,
    createdAt,
  });

  assert.ok(parseGuardianCommand(command(NOW - 5 * 60_000), NOW));
  assert.ok(parseGuardianCommand(command(NOW + 60_000), NOW));
  assert.equal(parseGuardianCommand(command(NOW - 5 * 60_000 - 1), NOW), null);
  assert.equal(parseGuardianCommand(command(NOW + 60_001), NOW), null);
});

test("atomically drains commands and removes invalid files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "guardian-inbox-"));
  const directory = path.join(root, "commands");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "001.json"), JSON.stringify({
    id: "command-1",
    action: "status",
    threadId: "thread-1",
    turnId: null,
    createdAt: NOW,
  }));
  await writeFile(path.join(directory, "002.json"), "invalid");

  const received: GuardianCommand[] = [];
  const invalid: string[] = [];
  const inbox = new CommandInbox({
    directory,
    pollIntervalMs: 60_000,
    now: () => NOW,
    onInvalid: (file) => invalid.push(file),
  });
  await inbox.start((command) => {
    received.push(command);
  });
  inbox.stop();

  assert.equal(received.length, 1);
  assert.equal(received[0]?.id, "command-1");
  assert.deepEqual(invalid, ["002.json"]);
  assert.deepEqual(await readdir(directory), []);
  await rm(root, { recursive: true, force: true });
});

test("rejects expired and excessively future commands exactly once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "guardian-inbox-"));
  const directory = path.join(root, "commands");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "001.json"), JSON.stringify({
    id: "expired",
    action: "enable",
    threadId: "thread-1",
    turnId: null,
    createdAt: NOW - 5 * 60_000 - 1,
  }));
  await writeFile(path.join(directory, "002.json"), JSON.stringify({
    id: "future",
    action: "disable",
    threadId: "thread-2",
    turnId: null,
    createdAt: NOW + 60_001,
  }));

  const received: GuardianCommand[] = [];
  const invalid: Array<{ file: string; reason: string }> = [];
  const inbox = new CommandInbox({
    directory,
    pollIntervalMs: 60_000,
    now: () => NOW,
    onInvalid: (file, reason) => invalid.push({ file, reason }),
  });
  await inbox.start((command) => {
    received.push(command);
  });
  inbox.stop();

  assert.deepEqual(received, []);
  assert.deepEqual(invalid.map(({ file }) => file), ["001.json", "002.json"]);
  assert.match(invalid[0]?.reason ?? "", /5 分钟/u);
  assert.match(invalid[1]?.reason ?? "", /1 分钟/u);
  assert.deepEqual(await readdir(directory), []);
  await rm(root, { recursive: true, force: true });
});

test("rejects symlink, directory, and oversized command files without following them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "guardian-inbox-"));
  const directory = path.join(root, "commands");
  const target = path.join(root, "target.json");
  const targetContents = JSON.stringify({
    id: "symlink-target",
    action: "enable",
    threadId: "thread-1",
    turnId: null,
    createdAt: NOW,
  });
  await mkdir(directory, { recursive: true });
  await writeFile(target, targetContents);
  await symlink(target, path.join(directory, "001.json"));
  await mkdir(path.join(directory, "002.json"));
  await writeFile(path.join(directory, "003.json"), Buffer.alloc(64 * 1024 + 1, 0x20));

  const received: GuardianCommand[] = [];
  const invalid: Array<{ file: string; reason: string }> = [];
  const failures: CommandInboxFailure[] = [];
  const inbox = new CommandInbox({
    directory,
    pollIntervalMs: 60_000,
    now: () => NOW,
    onInvalid: (file, reason) => invalid.push({ file, reason }),
    onFailure: (failure) => failures.push(failure),
  });
  await inbox.start((command) => {
    received.push(command);
  });
  inbox.stop();

  assert.deepEqual(received, []);
  assert.deepEqual(invalid.map(({ file }) => file), ["001.json", "002.json", "003.json"]);
  assert.match(invalid[0]?.reason ?? "", /符号链接/u);
  assert.match(invalid[1]?.reason ?? "", /非普通/u);
  assert.match(invalid[2]?.reason ?? "", /64 KiB/u);
  assert.deepEqual(failures, []);
  assert.equal(await readFile(target, "utf8"), targetContents);
  assert.deepEqual(await readdir(directory), []);
  await rm(root, { recursive: true, force: true });
});

test("keeps a valid command for retry when its listener fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "guardian-inbox-"));
  const directory = path.join(root, "commands");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "001.json"), JSON.stringify({
    id: "command-retry",
    action: "enable",
    threadId: "thread-1",
    turnId: "turn-1",
    createdAt: NOW,
  }));

  let attempts = 0;
  const inbox = new CommandInbox({
    directory,
    pollIntervalMs: 60_000,
    now: () => NOW,
  });
  await inbox.start(() => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("App Server unavailable");
    }
  });
  assert.deepEqual(await readdir(directory), ["001.retry-1.json"]);

  await inbox.drain();
  inbox.stop();
  assert.equal(attempts, 2);
  assert.deepEqual(await readdir(directory), []);
  await rm(root, { recursive: true, force: true });
});

test("recovers an abandoned atomic claim after the previous app crashed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "guardian-inbox-"));
  const directory = path.join(root, "commands");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "001.json.processing-99999"), JSON.stringify({
    id: "command-crash",
    action: "disable",
    threadId: "thread-1",
    turnId: "turn-1",
    createdAt: NOW,
  }));

  const received: string[] = [];
  const inbox = new CommandInbox({
    directory,
    pollIntervalMs: 60_000,
    now: () => NOW,
  });
  await inbox.start((command) => {
    received.push(command.id);
  });
  inbox.stop();

  assert.deepEqual(received, ["command-crash"]);
  assert.deepEqual(await readdir(directory), []);
  await rm(root, { recursive: true, force: true });
});

test("persists a bounded retry count, dead-letters poison, then continues in order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "guardian-inbox-"));
  const directory = path.join(root, "commands");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "001.json"), JSON.stringify({
    id: "poison",
    action: "enable",
    threadId: "thread-1",
    turnId: "turn-1",
    createdAt: NOW,
  }));
  await writeFile(path.join(directory, "002.json"), JSON.stringify({
    id: "healthy",
    action: "status",
    threadId: "thread-2",
    turnId: null,
    createdAt: NOW + 1,
  }));

  const firstAttempts: string[] = [];
  const firstInbox = new CommandInbox({
    directory,
    pollIntervalMs: 60_000,
    maxAttempts: 2,
    now: () => NOW,
  });
  await firstInbox.start((command) => {
    firstAttempts.push(command.id);
    throw new Error("permanent command failure");
  });
  firstInbox.stop();

  assert.deepEqual(firstAttempts, ["poison"]);
  assert.deepEqual(await readdir(directory), ["001.retry-1.json", "002.json"]);

  const secondAttempts: string[] = [];
  const failures: CommandInboxFailure[] = [];
  const invalid: string[] = [];
  const secondInbox = new CommandInbox({
    directory,
    pollIntervalMs: 60_000,
    maxAttempts: 2,
    now: () => NOW,
    onInvalid: (file) => invalid.push(file),
    onFailure: (failure) => failures.push(failure),
  });
  await secondInbox.start((command) => {
    secondAttempts.push(command.id);
    if (command.id === "poison") {
      throw new Error("still broken after restart");
    }
  });
  secondInbox.stop();

  assert.deepEqual(secondAttempts, ["poison", "healthy"]);
  assert.deepEqual(invalid, []);
  assert.equal(failures.length, 1);
  assert.deepEqual(
    {
      phase: failures[0]?.phase,
      attempt: failures[0]?.attempt,
      willRetry: failures[0]?.willRetry,
    },
    { phase: "listener", attempt: 2, willRetry: false },
  );
  assert.ok(failures[0]?.deadLetterPath?.includes(".dead-letter"));
  assert.deepEqual(await readdir(directory), [".dead-letter"]);
  assert.equal((await readdir(path.join(directory, ".dead-letter"))).length, 1);
  await rm(root, { recursive: true, force: true });
});

test("polling reports filesystem failures without an unhandled rejection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "guardian-inbox-"));
  const notADirectory = path.join(root, "commands");
  await writeFile(notADirectory, "not a directory", "utf8");

  const failures: CommandInboxFailure[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const inbox = new CommandInbox({
      directory: notADirectory,
      pollIntervalMs: 5,
      now: () => NOW,
      onFailure: (failure) => failures.push(failure),
    });
    await inbox.start(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    inbox.stop();

    assert.ok(failures.some((failure) => failure.phase === "recovery"));
    assert.ok(failures.some((failure) => failure.phase === "drain"));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await rm(root, { recursive: true, force: true });
  }
});
