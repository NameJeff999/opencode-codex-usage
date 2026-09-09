# Contributing

Bug reports, compatibility checks, documentation improvements, and focused pull requests are welcome.

## Development

Use Bun 1.3.10 or a compatible newer version:

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
```

Tests use synthetic credentials and mocked HTTP responses. Do not add real auth files, account responses, or reset-credit identifiers to fixtures. Never redeem a real credit from CI or an automated test.

For a report, include the plugin version, OpenCode version, operating system, whether you use TUI or Desktop, and steps to reproduce. `bun run doctor -- --offline --json` provides a report designed to omit credentials and private paths. Review anything you share and remove personal information from screenshots.

## Changes involving resets

Keep confirmation, account binding, and durable idempotency intact. A reset request must not leave the process until its exact attempt is committed to recovery storage. Never discard an uncertain attempt to start another one. Add behavioral tests for changes to redemption, recovery, or account switching.

## Scope

This is a plugin for stock OpenCode. TUI widgets and commands are distinct from Desktop chat tools. Do not describe Desktop tools as a native Desktop panel. Direct ChatGPT endpoints can change, so keep failures explicit and preserve unknown versus zero availability.

By submitting a contribution, you agree that it is available under the project's MIT license.
