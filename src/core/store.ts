import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_STATE_FILE_BYTES = 2 * 1024 * 1024;

export type JsonValidator<T> = (value: unknown) => value is T;

export class CorruptStoreError extends Error {
  readonly filePath: string;

  constructor(filePath: string) {
    super(`Refusing to overwrite corrupt state file: ${filePath}`);
    this.name = "CorruptStoreError";
    this.filePath = filePath;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** A small atomic JSON file store with corrupt-file overwrite protection. */
export class AtomicJsonStore<T> {
  readonly #filePath: string;
  readonly #fallback: () => T;
  readonly #validate: JsonValidator<T> | null;
  #corrupt = false;

  constructor(
    filePath: string,
    fallback: () => T,
    validate?: JsonValidator<T>,
  ) {
    this.#filePath = filePath;
    this.#fallback = fallback;
    this.#validate = validate ?? null;
  }

  async load(): Promise<T> {
    const contents = await readBoundedRegularFile(
      this.#filePath,
      MAX_STATE_FILE_BYTES,
      0o600,
    );
    if (contents === null) {
      this.#corrupt = false;
      return this.#fallback();
    }

    const parsed = this.#parseOrMarkCorrupt(contents);
    this.#corrupt = false;
    return parsed;
  }

  async save(value: T): Promise<void> {
    if (this.#corrupt) {
      throw new CorruptStoreError(this.#filePath);
    }

    const serialized = this.#serialize(value);

    await this.#assertExistingFileIsSafe();
    await this.#writeSerialized(serialized);
  }

  /**
   * Explicitly replaces local state without trusting or reading the old file.
   *
   * This is intentionally separate from save(): it is for a user-requested
   * privacy reset that must be able to recover from corrupt or oversized state.
   * A destination symlink is replaced as a directory entry, never followed.
   */
  async replace(value: T): Promise<void> {
    const serialized = this.#serialize(value);
    await this.#assertReplaceDestinationIsSafe();
    await this.#writeSerialized(serialized);
    this.#corrupt = false;
  }

  #serialize(value: T): string {
    if (this.#validate !== null && !this.#validate(value)) {
      throw new TypeError("Refusing to save invalid state");
    }

    const json = JSON.stringify(value, null, 2);
    if (json === undefined) {
      throw new TypeError("Refusing to save non-JSON state");
    }

    const serialized = `${json}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_FILE_BYTES) {
      throw new RangeError(
        `Refusing to write state file larger than ${MAX_STATE_FILE_BYTES} bytes`,
      );
    }
    return serialized;
  }

  async #writeSerialized(serialized: string): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });

    const temporaryPath = `${this.#filePath}.tmp-${process.pid}-${randomUUID()}`;
    let temporaryFile: Awaited<ReturnType<typeof open>> | null = null;
    try {
      temporaryFile = await open(temporaryPath, "wx", 0o600);
      await temporaryFile.writeFile(serialized, "utf8");
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = null;
      await rename(temporaryPath, this.#filePath);
      await syncDirectory(dirname(this.#filePath));
    } finally {
      if (temporaryFile !== null) {
        await temporaryFile.close().catch(() => undefined);
      }
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
    }
  }

  async #assertReplaceDestinationIsSafe(): Promise<void> {
    let pathStat: Awaited<ReturnType<typeof lstat>>;
    try {
      pathStat = await lstat(this.#filePath);
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }

    // rename(2) replaces the symlink itself; it does not follow its target.
    if (pathStat.isFile() || pathStat.isSymbolicLink()) {
      return;
    }

    throw new Error(
      `Refusing to replace non-regular state path: ${this.#filePath}`,
    );
  }

  #parseOrMarkCorrupt(contents: string): T {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      this.#corrupt = true;
      throw new CorruptStoreError(this.#filePath);
    }

    if (this.#validate !== null && !this.#validate(parsed)) {
      this.#corrupt = true;
      throw new CorruptStoreError(this.#filePath);
    }

    return parsed as T;
  }

  async #assertExistingFileIsSafe(): Promise<void> {
    const contents = await readBoundedRegularFile(
      this.#filePath,
      MAX_STATE_FILE_BYTES,
    );
    if (contents === null) {
      return;
    }

    this.#parseOrMarkCorrupt(contents);
  }
}

async function readBoundedRegularFile(
  filePath: string,
  maximumBytes: number,
  mode?: number,
): Promise<string | null> {
  let pathStat: Awaited<ReturnType<typeof lstat>>;
  try {
    pathStat = await lstat(filePath);
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }

  if (pathStat.isSymbolicLink()) {
    throw new Error(`Refusing to read symbolic link as state: ${filePath}`);
  }
  if (!pathStat.isFile()) {
    throw new Error(`Refusing to read non-regular state file: ${filePath}`);
  }

  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) {
      throw new Error(`Refusing to read non-regular state file: ${filePath}`);
    }
    if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error(`Refusing to read state file changed during validation: ${filePath}`);
    }
    if (openedStat.size > maximumBytes) {
      throw new Error(
        `Refusing to read state file larger than ${maximumBytes} bytes: ${filePath}`,
      );
    }
    if (mode !== undefined) {
      // Tighten legacy permissions through the already-verified descriptor so
      // a path swap cannot redirect chmod to a different file.
      await handle.chmod(mode);
    }
    return await readAtMost(handle, maximumBytes, filePath);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readAtMost(
  handle: Awaited<ReturnType<typeof open>>,
  maximumBytes: number,
  filePath: string,
): Promise<string> {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      total,
      buffer.length - total,
      total,
    );
    if (bytesRead === 0) {
      break;
    }
    total += bytesRead;
  }
  if (total > maximumBytes) {
    throw new Error(
      `Refusing to read state file larger than ${maximumBytes} bytes: ${filePath}`,
    );
  }
  return buffer.subarray(0, total).toString("utf8");
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Directory fsync is unavailable on some supported filesystems/platforms.
    // The temporary file itself was still fsynced before the atomic rename.
    if (!isUnsupportedDirectorySync(error)) {
      throw error;
    }
  } finally {
    if (handle !== null) {
      await handle.close().catch(() => undefined);
    }
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return (
    error.code === "EINVAL" ||
    error.code === "ENOTSUP" ||
    error.code === "EOPNOTSUPP" ||
    error.code === "EBADF" ||
    error.code === "EISDIR"
  );
}
