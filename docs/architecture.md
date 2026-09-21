# Integration and compatibility

## Authentication and CIMD

The CLI uses OAuth Device Flow for every interactive login. Its public CIMD
client ID is `https://hyper3d.ai/oauth_cimd/cli.json`. Deploy the JSON in
`oauth_cimd/cli.json` at that exact URL, anonymously with
`Content-Type: application/json`. It declares Device Flow and refresh-token
grants, with empty `redirect_uris` and `response_types`. No client secret or
localhost callback is used. Publishing CIMD does not publish the CLI to npm.

```sh
npm run cli -- auth login
npm run cli -- auth login --no-browser
npm run cli -- auth status
npm run cli -- auth logout
```

Login prints a code and opens the returned `verification_uri_complete` URL.
The backend then redirects the browser to
`https://hyper3d.ai/workspace/oauth/device?interaction=<handle>`.
The CLI uses the returned verification URL, not a hardcoded frontend URL.
The user confirms that the browser code matches the terminal, then authorizes
the CLI. `--no-browser` only prints the link/code for SSH or another device.
Failure to launch the browser leaves the same login waiting for manual approval.
The CLI polls until success, denial or device-code expiry and handles polling
backoff. Ctrl+C cancels login. Login never falls back to authorization-code/PKCE.

Deploy the backend Device Flow support, frontend device confirmation page and
updated CIMD, and add the exact client ID to `grant.device_flow_client_ids`
before using this against production. The CLI fails explicitly when the server
does not advertise Device Flow. Existing MCP clients retain their own login flows.

The SDK handles OAuth discovery, resource validation and subsequent token
requests. Normal MCP operations only refresh stored credentials; they never
start interactive login. Existing refresh tokens can still be used if the server
accepts them. The official client identity is fixed internally and cannot be
overridden through CLI options, environment variables or stored credentials.
No DCR fallback.

Credentials are stored per endpoint in `~/.hyper3d` (directory mode 0700, token
file mode 0600 on POSIX); they are not encrypted. On Windows, storage inherits
the user's directory ACLs. `HYPER3D_CONFIG_DIR` can change that directory.
`auth status` (alias `auth info`) verifies credentials by calling the existing
`POST /api/user/get_info` HTTP API. It displays the username, user UUID, and the
separate regular, subscription and frozen credit balances of an authorized personal
workspace. Team workspaces display their separate regular and frozen balances. For team grants it
also calls `POST /api/group/group_info` with the group UUID returned by the server.
It does not call MCP tools or query wallet usage. Expired stored access tokens
are refreshed once. Without credentials,
the default output says the user is not authenticated; `--output json` returns
`{ "authenticated": false }`. Authentication, server and network errors fail
explicitly rather than reporting a verified login.

The CLI explicitly requests `rodin:generate rodin:read account:read offline_access`;
it never requests every scope advertised by discovery. Deploy backend support for
`account:read` and the updated official CIMD before using account lookup. Existing
users must run `hyper3d auth login` again to grant the new permission. Refreshing
an older grant does not add scopes. Existing MCP tool permissions and the public
MCP discovery scope list remain unchanged.

The internal `expiresAt` credential field records access-token expiry in Unix
milliseconds, not refresh-token expiry. Status output omits client metadata,
credential storage details and tokens.
Logout removes local credentials; it does not revoke the server-side grant.

## Model commands

```sh
hyper3d generate --image ./reference.png
hyper3d generate --image ./front.png --image ./side.jpg --prompt "a ceramic teapot"
hyper3d generate --prompt "a ceramic teapot" --tier Gen-2.5-High --format glb
hyper3d status <generation-id>
hyper3d poll <generation-id> --timeout 300
hyper3d result <generation-id>
hyper3d bang <generation-id> --instruction "separate the handle and lid"
```

`generate` accepts one to five local images and/or a prompt. It validates options,
requests presigned uploads, PUTs each image in order, and starts generation only
after every upload succeeds. It submits generation once and never retries or
switches contracts after an error or timeout. After an ambiguous generation
failure, inspect existing tasks before generating again. Failed uploads may leave
unused upload allocations; they do not start generation. Image type is inferred
from the filename extension. Upload destinations must use HTTPS; uploads never
receive the CLI's MCP authorization header.

Commands print concise human-readable operation data by default. Pass the global
`--output json` option for scripting; it preserves the complete operation data:

```sh
hyper3d --output json generate --prompt "a ceramic teapot"
hyper3d status <generation-id> --output json
```

`result` returns file URLs, without downloading them. `poll` accepts any positive
integer timeout in seconds. It automatically chains wait-tool calls of at most
30 seconds until generation finishes or the total timeout expires.

## Operation contracts

The CLI selects its current bundled contract internally (currently `v1`).
There is no public schema-version option.
`src/contracts/<version>/` contains each contract's schema and implementation;
authentication and transport are shared. There is currently one real contract.
When a breaking wire/behavior change requires another implementation, retain the
previous generation alongside the current one; support at most two generations.
An enum addition alone does not create a new generation. These are local CLI
contract versions, not a claim that the server supports version negotiation.

Actual requests are validated against the live server schema. Differences from
the bundled input schema warn but do not reject input accepted by the server.
New enum values are passed through; no value is silently replaced. Output data is
preserved, including unknown enums, while the MCP SDK validates the server's own
output schema. Workflows validate the output fields they need before continuing.

The `v1` contract snapshot was captured from the public production tool list. It
contains 7 tools and their input/output schemas. It is a review baseline, not a
claim that billable operations were exercised.

Named operations validate actual input against the **remote** schema. A breaking
change in the abstract does not block an operation whose actual input satisfies
the current remote schema. The SDK validates declared structured outputs.

The bundled snapshot describes the CLI's known contract; it does not establish
whether a CLI release is outdated. Additive server changes may remain compatible,
and schema differences cannot detect changed semantics. Normal commands validate
their actual input rather than running a full schema diff. A newer npm version
indicates an available update; an explicit minimum-version policy is needed to
require an upgrade. No production minimum-version policy URL is configured yet.

The compatibility analyzer deliberately handles a limited subset: required
fields and enum narrowing are recognized; other constraint/type/output changes
are conservatively reported as unknown. It ignores documentation and irrelevant
ordering. It is not a general JSON Schema containment solver. Schemas cannot
detect changes in business semantics. Tool absence can also be due to scopes.

Other command failures and tool `isError` results exit 1; success exits 0.

`--base-url` or `BASE_URL` overrides the default `https://api.hyper3d.com/api`.
A trailing slash is optional. MCP and account endpoints are resolved relative to
this base; credentials remain keyed by the derived MCP URL, so the two spellings
share the same login. HTTPS is required except on loopback hosts. OAuth endpoints
are discovered through server metadata rather than guessed from the base URL.
