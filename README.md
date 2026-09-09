# OpenCode Codex Usage

ChatGPT Codex account limits and banked usage resets for OpenCode TUI and stock Desktop. Version 0.3.0 adds persistent reset recovery, configuration setup, and diagnostics.

**Public beta.** This is an independent community plugin, not an official OpenAI or OpenCode product. Automated tests cover account changes, interrupted requests, and recovery; live Desktop approval and real credit redemption still need end-to-end validation. Direct ChatGPT backend endpoints may change.

| Capability       | OpenCode TUI                         | Stock Desktop                                  |
| ---------------- | ------------------------------------ | ---------------------------------------------- |
| Usage display    | Persistent footer and `/codex-usage` | `codex_usage` chat tool                        |
| Banked reset     | Picker and confirmation              | `codex_reset` with default permission approval |
| Diagnostics      | `/codex-doctor`                      | `codex_doctor` chat tool                       |
| Restart recovery | Saved attempt offered in picker      | Saved `retryId` available across sessions      |

## Requirements

- OpenCode 1.18.5–1.x; validated against the 1.18.30 plugin API.
- OpenAI connected through ChatGPT OAuth in OpenCode. API-key authentication does not provide these account limits.
- Bun for installing dependencies and running the setup/doctor CLI. Recovery uses Bun's built-in SQLite runtime, also provided by OpenCode.

## Local installation

Clone the repository into a location you will keep, then run:

```sh
git clone https://github.com/NameJeff999/opencode-codex-usage.git
cd opencode-codex-usage
bun install
bun run setup -- --both --dry-run
bun run setup -- --both
```

Use `--tui` for only the terminal UI, `--server` for Desktop/server tools, or `--both`. Setup inserts file URLs for the current checkout, preserves existing plugins, JSONC comments, and permission settings, and creates a backup beside each existing file it changes. Re-running it does not add duplicate entries. It refuses malformed configurations or ambiguous JSON/JSONC pairs. Restart OpenCode afterward.

By default it uses `OPENCODE_CONFIG_DIR` if set, otherwise the XDG OpenCode configuration directory (`~/.config/opencode` by default). Use `--config-dir PATH` for another directory or a project. Setup only edits that directory; it does not change authentication or redeem credits. Project and agent policies may still override these settings. Keep the checkout at its installed location, or update the file URLs after moving it.

For manual setup, merge the following entries into existing configuration, preserving other settings.

For **Desktop (or server tools in TUI)**, add the server entry to `opencode.json` in your project, or your OpenCode configuration directory:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-codex-usage/src/server.ts"],
  "permission": {
    "codex_reset": "ask"
  }
}
```

For the **TUI footer, commands, and reset picker**, add the TUI entry separately to `tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["file:///absolute/path/to/opencode-codex-usage/src/tui.tsx"]
}
```

Replace the placeholder with your checkout's absolute file URL. On Windows, for example, use `file:///C:/Projects/opencode-codex-usage/src/server.ts`. The setup command generates correct URLs automatically. The package exports `.` and `/server` for server tools, and `/tui` for the terminal interface; installation does not depend on an npm publication. You can enable either entry or both.

## Desktop

Ask the agent to **“Use codex_usage to show my Codex limits and banked resets.”** The read-only tool returns all reported usage buckets, reset windows, and available credit details.

Ask **“Use codex_doctor to diagnose my Codex setup.”** for connectivity, authentication, configuration, and recovery checks. The optional `offline: true` argument skips network requests.

To spend a credit, explicitly ask **“Use codex_reset to redeem one banked reset.”** The tool requests OpenCode's standard permission approval before sending the reset request. The default policy is `ask`; explicit permission rules, including global deny, remain authoritative. An explicit `allow` rule bypasses the approval prompt, so keep `ask` for interactive confirmation.

Stock Desktop support uses chat tools and permission prompts. It does not add a native Desktop usage widget or a standalone reset button. The agent needs a working model/provider to invoke a tool; if the selected Codex model cannot respond because its quota is exhausted, select another working provider first. An expired ChatGPT token still requires OpenCode to refresh the login.

## TUI

- The prompt footer shows **Codex account** usage, remaining percentages, reset countdowns, and the banked reset count.
- Click usage or run `/codex-usage` for a refreshed view of every reported quota bucket.
- Click the reset count or run `/codex-reset` to select a credit. Confirmation defaults to cancellation.
- Run `/codex-doctor` for setup diagnostics without a model call.
- Failed refreshes are marked stale or unavailable. Failed inventory reads are reported as unknown, rather than zero.
- No automatic redemption or exhaustion popup occurs.

Usage is account-wide and shown independently of the selected model. The public TUI plugin API does not expose a reliable live model selection accessor, so the footer does not guess which quota governs the selected model.

## Account and retry behavior

The plugin reads OpenCode's existing OAuth login without modifying it or refreshing tokens itself. The TUI uses the login on the TUI host; server tools use the login on the server host. When attaching to a remote server, install the server entry there and use the tools for that server's account. The local TUI footer cannot infer the remote server's login.

Each reset attempt is bound to the account that was displayed before confirmation. Account changes invalidate stale views and are checked again before requests. After redemption, fresh usage and inventory requests replace any earlier poll.

If a request has an unknown outcome, retry the **same attempt**. Before sending any reset POST, the plugin commits the account fingerprint, selected credit ID, idempotency key, and creation time to a local SQLite recovery database. Known outcomes are saved afterward. OAuth tokens, account response bodies, and chat contents are never saved there.

The database is `codex-usage/resets.sqlite` beside OpenCode's normal `auth.json` directory (normally `~/.local/share/opencode/codex-usage/resets.sqlite`, honoring `XDG_DATA_HOME`). Keep the database and any SQLite sidecar files together when backing up. The default data directory is shared by the TUI and server on the same host; it is not synchronized between remote machines.

After a restart, `/codex-reset` offers the saved retry before checking whether another credit is available. The server tool returns `retry_required` with a `retryId`; retry with that ID even from a new chat session. Retrying still requires confirmation under the default permission policy. There is no automatic redemption on startup.

Only one unresolved attempt per account can be reserved across instances. A different request is blocked until the saved attempt has a known outcome. Completed records also prevent an old retry ID from spending another credit. Records are not automatically expired or pruned. If storage is inaccessible or invalid, redemption is blocked; use the doctor and preserve recovery data instead of deleting it to bypass the block. Pending attempts from versions before 0.3.0 were memory-only and cannot be recovered after those versions restart.

Requests go to ChatGPT's `backend-api/wham` usage and reset endpoints. Tokens are read when needed and are not included in tool output or logs. Endpoint availability and reset eligibility are determined by ChatGPT.

## Diagnostics

```sh
bun run doctor
bun run doctor -- --offline --json
bun run doctor -- --config-dir /path/to/config --opencode-version 1.18.30
```

The report checks plugin version, supplied/host OpenCode version, the inspected configuration directory, reset permission policy, OAuth availability/expiry, recovery database health, and independent usage/inventory GET requests. Offline mode makes no network requests. Diagnostics never redeem a reset, refresh tokens, or modify OpenCode configuration; opening recovery storage may initialize its local database.

Reports omit credentials, raw account IDs, local paths, and raw server responses. Configuration checks cover the selected directory, not every merged project/agent/remote scope. A running plugin is reported as loaded even if configured elsewhere. The TUI supplies its host version; standalone/server diagnostics report version as unknown unless supplied, rather than guessing. Missing authentication, invalid storage/configuration, or failed endpoint checks produce a nonzero CLI exit code; warnings and offline skips do not.

For `401`, refresh/reconnect ChatGPT OAuth. For `403`, check eligibility or network access. For `429`, wait before retrying. Unknown inventory remains distinct from an empty balance.

## Development and validation

```sh
bun install
bun test
bun run typecheck
```

Tests use synthetic credentials and mocked HTTP responses. They cover account switches during approval, stale response races, expired login recovery, additional usage buckets, unknown inventory, permission denial, dialog cancellation, and idempotent retries. Typechecking targets `@opencode-ai/plugin` 1.18.30. Live Desktop UI approval and real credit redemption have not been exercised by these checks.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidance, [SECURITY.md](SECURITY.md) for reporting vulnerabilities, and [CHANGELOG.md](CHANGELOG.md) for release changes. Licensed under [MIT](LICENSE).
