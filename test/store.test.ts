import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AtomicJsonStore, CorruptStoreError } from "../src/core/store.js";

interface State {
  count: number;
}

function isState(value: unknown): value is State {
  return (
    typeof value === "object" &&
    value !== null &&
    "count" in value &&
    typeof value.count === "number"
  );
}

async function withTemporaryDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "codex-resume-store-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("returns fallback for a missing file and atomically persists JSON", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, "nested", "state.json");
    const store = new AtomicJsonStore<State>(filePath, () => ({ count: 0 }), isState);

    assert.deepEqual(await store.load(), { count: 0 });
    await store.save({ count: 4 });
    assert.deepEqual(await store.load(), { count: 4 });

    const files = await readdir(join(directory, "nested"));
    assert.deepEqual(files, ["state.json"]);
    assert.equal(await readFile(filePath, "utf8"), '{\n  "count": 4\n}\n');
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  });
});

test("tightens permissions on a valid legacy state file during load", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, "state.json");
    const contents = '{"count":7}\n';
    await writeFile(filePath, contents, "utf8");
    await chmod(filePath, 0o644);
    const store = new AtomicJsonStore<State>(filePath, () => ({ count: 0 }), isState);

    assert.deepEqual(await store.load(), { count: 7 });
    assert.equal(await readFile(filePath, "utf8"), contents);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  });
});

test("rejects a state symlink without reading or chmodding its target", async () => {
  await withTemporaryDirectory(async (directory) => {
    const targetPath = join(directory, "target.json");
    const filePath = join(directory, "state.json");
    const contents = '{"count":7}\n';
    await writeFile(targetPath, contents, "utf8");
    await chmod(targetPath, 0o644);
    await symlink(targetPath, filePath);
    const store = new AtomicJsonStore<State>(filePath, () => ({ count: 0 }), isState);

    await assert.rejects(store.load(), /symbolic link/u);
    await assert.rejects(store.save({ count: 8 }), /symbolic link/u);
    assert.equal(await readFile(targetPath, "utf8"), contents);
    assert.equal((await stat(targetPath)).mode & 0o777, 0o644);
  });
});

test("rejects a non-regular state path", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, "state.json");
    await mkdir(filePath);
    const store = new AtomicJsonStore<State>(filePath, () => ({ count: 0 }), isState);

    await assert.rejects(store.load(), /non-regular state file/u);
    await assert.rejects(store.save({ count: 8 }), /non-regular state file/u);
  });
});

test("rejects state files larger than 2 MiB", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, "state.json");
    await writeFile(filePath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    const store = new AtomicJsonStore<State>(filePath, () => ({ count: 0 }), isState);

    await assert.rejects(store.load(), /larger than 2097152 bytes/u);
    await assert.rejects(store.save({ count: 8 }), /larger than 2097152 bytes/u);
  });
});

test("rejects an oversized save before touching valid existing state", async () => {
  await withTemporaryDirectory(async (directory) => {
    interface BlobState {
      payload: string;
    }
    const isBlobState = (value: unknown): value is BlobState =>
      typeof value === "object" &&
      value !== null &&
      "payload" in value &&
      typeof value.payload === "string";
    const filePath = join(directory, "state.json");
    const original = '{"payload":"keep-me"}\n';
    await writeFile(filePath, original, "utf8");
    const store = new AtomicJsonStore<BlobState>(
      filePath,
      () => ({ payload: "fallback" }),
      isBlobState,
    );

    await assert.rejects(
      store.save({ payload: "x".repeat(2 * 1024 * 1024) }),
      /larger than 2097152 bytes/u,
    );
    assert.equal(await readFile(filePath, "utf8"), original);

    await store.save({ payload: "small" });
    assert.deepEqual(await store.load(), { payload: "small" });
  });
});

test("recovers after a transient filesystem failure without poisoning the store", async () => {
  await withTemporaryDirectory(async (directory) => {
    const parentPath = join(directory, "state");
    const filePath = join(parentPath, "state.json");
    await writeFile(parentPath, "temporarily blocking the directory", "utf8");
    const store = new AtomicJsonStore<State>(filePath, () => ({ count: 0 }), isState);

    await assert.rejects(store.save({ count: 1 }));

    await rm(parentPath);
    await mkdir(parentPath);
    await store.save({ count: 2 });
    assert.deepEqual(await store.load(), { count: 2 });
  });
});

test("a corrupt file is never overwritten after load fails", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, "state.json");
    await writeFile(filePath, "{broken", "utf8");
    const store = new AtomicJsonStore<State>(filePath, () => ({ count: 0 }), isState);

    await assert.rejects(store.load(), CorruptStoreError);
    await assert.rejects(store.save({ count: 1 }), CorruptStoreError);
    assert.equal(await readFile(filePath, "utf8"), "{broken");
  });
});

test("explicit replace recovers corrupt state after load fails", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, "state.json");
    await writeFile(filePath, "{broken", "utf8");
    const store = new AtomicJsonStore<State>(filePath, () => ({ count: 0 }), isState);

    await assert.rejects(store.load(), CorruptStoreError);
    await store.replace({ count: 9 });

    assert.deepEqual(await store.load(), { count: 9 });
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  });
});

test("explicit replace recovers an oversized state file without reading it", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, "state.json");
    await writeFile(filePath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    const store = new AtomicJsonStore<State>(filePath, () => ({ count: 0 }), isState);

    await store.replace({ count: 10 });

    assert.deepEqual(await store.load(), { count: 10 });
  });
});

test("explicit replace replaces a symlink but never follows its target", async () => {
  await withTemporaryDirectory(async (directory) => {
    const targetPath = join(directory, "target.json");
    const filePath = join(directory, "state.json");
    const targetContents = '{"count":7}\n';
    await writeFile(targetPath, targetContents, "utf8");
    await chmod(targetPath, 0o644);
    await symlink(targetPath, filePath);
    const store = new AtomicJsonStore<State>(filePath, () => ({ count: 0 }), isState);

    await store.replace({ count: 11 });

    assert.deepEqual(await store.load(), { count: 11 });
    assert.equal(await readFile(targetPath, "utf8"), targetContents);
    assert.equal((await stat(targetPath)).mode & 0o777, 0o644);
  });
});

test("explicit replace refuses to replace a directory", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, "state.json");
    await mkdir(filePath);
    const store = new AtomicJsonStore<State>(filePath, () => ({ count: 0 }), isState);

    await assert.rejects(
      store.replace({ count: 12 }),
      /non-regular state path/u,
    );
    assert.equal((await stat(filePath)).isDirectory(), true);
  });
});

test("save checks an existing file even when load was never called", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, "state.json");
    await writeFile(filePath, "not-json", "utf8");
    const store = new AtomicJsonStore<State>(filePath, () => ({ count: 0 }), isState);

    await assert.rejects(store.save({ count: 3 }), CorruptStoreError);
    assert.equal(await readFile(filePath, "utf8"), "not-json");
  });
});

test("schema-invalid JSON is treated as corrupt and preserved", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, "state.json");
    await writeFile(filePath, '{"count":"wrong"}\n', "utf8");
    const store = new AtomicJsonStore<State>(filePath, () => ({ count: 0 }), isState);

    await assert.rejects(store.load(), CorruptStoreError);
    assert.equal(await readFile(filePath, "utf8"), '{"count":"wrong"}\n');
  });
});

test("refuses to save a value rejected by the validator", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, "state.json");
    const store = new AtomicJsonStore<State>(filePath, () => ({ count: 0 }), isState);

    await assert.rejects(
      store.save({ count: "wrong" } as unknown as State),
      TypeError,
    );
    await assert.rejects(readFile(filePath, "utf8"), { code: "ENOENT" });
  });
});
