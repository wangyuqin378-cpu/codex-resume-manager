# Codex Auto Resume plugin

This repository is a local Codex marketplace. Install the plugin from the
repository root:

```sh
codex plugin marketplace add /absolute/path/to/codex-resume-manager
codex plugin add codex-auto-resume@codex-resume-manager-local
```

Then use one of these requests in the Codex task you want to protect:

- `开启自动续跑`
- `关闭自动续跑`
- `查看自动续跑状态`

The plugin does not read Codex authentication, SQLite databases, transcripts,
or rollout files. Its `UserPromptSubmit` hook only receives the metadata Codex
passes on standard input and writes a small command to:

```text
~/Library/Application Support/codex-resume-manager/commands
```

After the command is durable, the hook attempts to wake an installed manager in
the background. It first checks `app-location.json` in the manager's user-data
directory, then `~/Applications/CodexResumeManager.app`. It does not bring the
app to the foreground.

Run the hook tests with:

```sh
node --test plugins/codex-auto-resume/test/*.test.mjs
```
