const ALLOWED_ENVIRONMENT_KEYS = new Set([
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Codex may intentionally use API-key authentication instead of the local
  // login file. These values are passed directly to Codex and never inspected,
  // persisted, logged, or exposed to the renderer.
  "OPENAI_API_KEY",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
]);

/** Prevent unrelated shell credentials (for example GitHub or AWS) from
 * being inherited by the Codex child process. */
export function codexChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      (ALLOWED_ENVIRONMENT_KEYS.has(key) || key.startsWith("LC_") || key.startsWith("CODEX_"))
    ) {
      filtered[key] = value;
    }
  }
  return filtered;
}
