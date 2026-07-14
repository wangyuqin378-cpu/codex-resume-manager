import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Resolve Codex without embedding a developer-specific home directory.
 * Packaged macOS apps usually receive a smaller PATH than an interactive shell,
 * so the common per-user and Homebrew locations are checked explicitly.
 */
export function resolveCodexPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const override = env.CODEX_RESUME_MANAGER_CODEX_PATH?.trim();
  if (override) {
    return override;
  }

  const pathCandidates = (env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0)
    .map((entry) => path.join(entry, "codex"));
  const candidates = [
    ...pathCandidates,
    path.join(home, ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];

  for (const candidate of new Set(candidates)) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking. Returning the bare command below preserves the normal
      // PATH error when Codex is not installed anywhere we can discover.
    }
  }
  return "codex";
}
