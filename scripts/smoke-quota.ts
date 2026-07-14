import { CodexAppServerClient } from "../src/main/codex-app-server.js";
import { resolveCodexPath } from "../src/main/codex-path.js";

const client = new CodexAppServerClient({
  codexPath: resolveCodexPath(),
});

try {
  await client.start();
  const snapshot = await client.readRateLimits();
  const windows = Object.values(snapshot.rateLimitsByLimitId ?? {}).flatMap((limit) =>
    [limit.primary, limit.secondary].filter((window) => window !== null),
  );
  process.stdout.write(`Codex quota smoke check passed (${windows.length} windows).\n`);
} finally {
  await client.close();
}
