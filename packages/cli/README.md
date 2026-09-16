# Hyper3D CLI

An npm-distributed CLI for Hyper3D MCP tools. Requires Node.js 22+.

This is an unpublished development build. See the repository README for setup,
authentication, schema compatibility and release instructions:
https://github.com/DeemosTech/hyper3d-cli

```sh
hyper3d --help
hyper3d auth login
hyper3d auth login --no-browser
hyper3d auth status
hyper3d tools list
hyper3d tools describe rodin_generate
hyper3d schema check
hyper3d update --check
```

Use `HYPER3D_ACCESS_TOKEN` for an existing MCP OAuth access token in automation.
Outputs are JSON; warnings are written to stderr. Generation consumes credits.

Login uses Device Flow: compare the terminal code with the browser and confirm.
The backend redirects to `https://hyper3d.ai/workspace/oauth/device?interaction=<handle>`;
the CLI always opens the verification URL returned by the server.
Client identity is managed internally; no client configuration or localhost
listener is required. `hyper3d auth status` (alias `hyper3d auth info`) displays
your username, user UUID and the authorized personal/team wallet's balance and
frozen credits using the existing HTTP APIs. No MCP tool or usage query is needed.
Account lookup requires backend `account:read` support and the updated official
client metadata. Run `hyper3d auth login` again to authorize it for an older login.
Stored credentials refresh automatically after access-token expiry; network and
authorization failures are reported as errors.
