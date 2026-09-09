# Changelog

## 0.3.0 — First public beta

- OpenCode TUI usage footer, quota details, banked-reset picker, and explicit confirmation.
- Stock Desktop/server tools: `codex_usage`, `codex_reset`, and `codex_doctor`.
- Persistent reset recovery with SQLite transactions, original account/credit/idempotency keys, and protection against conflicting pending attempts across instances.
- Account-switch checks, expired-login reporting, additional quota buckets, stale-response protection, and fresh post-redemption reads.
- Setup command that preserves existing JSON/JSONC settings, creates backups, and supports dry runs.
- Diagnostics for authentication, configuration, endpoint access, and recovery storage, including offline JSON output.
- 46 automated tests and TypeScript validation against the OpenCode 1.18.30 plugin API.

Live Desktop approval and real credit redemption have not been exercised by the automated validation. Desktop support uses chat tools; it does not add a native usage panel.
