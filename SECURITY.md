# Security

## Reporting a vulnerability

Do not post OAuth tokens, auth.json, raw account responses, recovery databases, or working exploit credentials in public issues.

If the repository's Security tab offers **Report a vulnerability**, use that private reporting flow. Otherwise open a minimal issue asking the maintainer for a private reporting channel without including sensitive details.

## Data access and limitations

- The plugin reads OpenCode's existing ChatGPT OAuth credentials on the host where each entry runs. It does not refresh or change those credentials.
- Usage and inventory checks send authenticated GET requests to ChatGPT. Redemption sends a POST only after the TUI confirmation or the server's configured permission decision. Explicit `allow` policies bypass the server approval prompt.
- Recovery storage contains hashed account identity, attempt ID, optional credit ID, creation time, and known outcome. It does not contain access/refresh tokens or chat text. Treat the database as private account-related metadata.
- Do not delete recovery storage to bypass an unresolved attempt. Preserve the database and any SQLite sidecars together when making a backup.
- Direct ChatGPT backend endpoints are not a guaranteed stable public API. This is an independent community project with no OpenAI or OpenCode affiliation or endorsement.

Only the current release is maintained. The first public release is a beta; automated tests do not establish that every live account, platform, or host version works.
