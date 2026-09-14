# Hyper3D CLI

npm workspace for the Hyper3D MCP CLI. Business operations remain in the existing
Hyper3D backend. This repository owns the CLI, its reviewed tool schema snapshot,
and release policy artifacts.

## Development

Requires Node.js 22 or newer and npm.

```sh
npm ci
npm run cli -- --help
npm run cli -- tools list
npm run cli -- schema check
npm test
npm run pack:check
```

`packages/cli` is the distributable package. The provisional name is `@hyper3d/cli`.
It is marked `private: true` until the npm scope, ownership and initial release
are configured. No npm release has been made. No global installation is needed
for development. All data output is JSON on stdout; warnings go to stderr.

## Authentication and CIMD

The CLI supports a CIMD public native client with authorization code + PKCE.
Host its metadata on the **Hyper3D official HTTPS domain**. The exact public URL
is a deployment decision; the URL below is an example, not an existing endpoint.

```sh
npm run cli -- auth metadata --client-id https://hyper3d.com/oauth/cli.json
```

To produce a file, use the executable directly so npm's own banner is not included:

```sh
node packages/cli/src/index.js auth metadata \
  --client-id https://hyper3d.com/oauth/cli.json > client-metadata.json
```

Serve that JSON at exactly the selected `client_id` URL, anonymously, with
`Content-Type: application/json`. The CLI callback is
`http://127.0.0.1:43817/callback`; deploy the generated redirect URI unchanged.
There is no client secret. Publishing CIMD does not publish the CLI to npm.

```sh
node packages/cli/src/index.js auth login --client-id https://hyper3d.com/oauth/cli.json
node packages/cli/src/index.js auth status
node packages/cli/src/index.js auth logout
```

Login prints a browser link and waits up to five minutes for the loopback callback.
The final CIMD URL must be deployed before this can be tested against production.
The SDK handles OAuth discovery, PKCE, resource indicators and token refresh.
This client uses the CIMD ID explicitly and does not fall back to DCR.

Credentials are stored per endpoint in `~/.hyper3d` (directory mode 0700, token
file mode 0600 on POSIX); they are not encrypted. On Windows, storage inherits
the user's directory ACLs. `HYPER3D_CONFIG_DIR` can change that directory.
`auth status` only reports local credential presence, not remote validity.
Logout removes local credentials; it does not revoke the server-side grant.

For automation, pass an **OAuth access token valid for this MCP resource** via
`HYPER3D_ACCESS_TOKEN`. This is not an assertion that ordinary Hyper3D API keys
are accepted. Tokens are never passed as CLI arguments.

## Tools and schema checks

```sh
node packages/cli/src/index.js tools describe rodin_generate
node packages/cli/src/index.js tools call rodin_generate --json '{"prompt":"a ceramic teapot"}'
node packages/cli/src/index.js tools call rodin_get_status --json-file request.json
```

Generation consumes credits. Each invocation sends one tool call; the CLI does
not retry failed or timed-out calls. After an ambiguous timeout, inspect existing
tasks before initiating another generation.

The bundled `schema/tools.json` was captured from the public production tool
list on 2026-09-14. It contains 7 tools and their input/output schemas. It is a
review baseline, not a claim that billable operations were exercised.

Before a call, the CLI compares only the selected tool with the baseline, emits
warnings for relevant drift, and validates input against the **remote** schema.
Unknown/new tools remain callable. A breaking change in the abstract does not
block a generic call whose actual input satisfies the current remote schema.
The full MCP result envelope is preserved, including `isError` and structured
output. The SDK validates declared structured outputs.

The compatibility analyzer deliberately handles a limited subset: required
fields and enum narrowing are recognized; other constraint/type/output changes
are conservatively reported as unknown. It ignores documentation and irrelevant
ordering. It is not a general JSON Schema containment solver. Schemas cannot
detect changes in business semantics. Tool absence can also be due to scopes.

```sh
node packages/cli/src/index.js schema check
node packages/cli/src/index.js schema snapshot --out /tmp/candidate-tools.json
```

Snapshot creation refuses to overwrite an existing file. Review the candidate
diff, validate affected workflows, then explicitly replace the bundled baseline
in a commit. Normal execution never rewrites it. `schema check` exits 2 for
breaking/unknown drift, while newly added tools alone do not fail the check.
Other command failures and tool `isError` results exit 1; success exits 0.

`--endpoint` or `HYPER3D_MCP_URL` overrides the default
`https://api.hyper3d.com/api/mcp`. HTTPS is required except on loopback hosts.

## npm updates and minimum versions

After the package is published:

```sh
hyper3d update --check
hyper3d update
hyper3d update --channel beta
```

Updates resolve `latest`/`beta` via npm then install that exact version. An update
only mutates a verified global installation; local/npx/development installations
receive guidance instead. On Windows, if npm's JS entry point is unavailable,
the current implementation asks you to run npm install directly.

Published builds check at most once a day before interactive tool calls.
`HYPER3D_UPDATE_CHECK=0` disables the check. Set `HYPER3D_AUTO_UPDATE=1` to opt into
installation at that boundary; CI and noninteractive runs never self-update.
After a successful automatic install, the requested tool is **not** called;
run the command again. No original generation request is replayed.

`release-policy/stable.json` is the independent minimum-version policy. Host it
as static HTTPS JSON and configure `HYPER3D_RELEASE_POLICY_URL`, or set
`hyper3d.releasePolicyUrl` in the CLI package before release. No production policy
URL is configured yet. Below the minimum version, tool calls fail with
`CLIENT_UPGRADE_REQUIRED`; auth, update and discovery remain usable.
Network/invalid policy errors warn and allow continuing. This is a client-side
compatibility aid, not server enforcement or a security boundary. Server-side
rejection of unsupported behavior belongs in the existing backend.

## Release checklist

1. Confirm the npm package name and scope access; update package metadata and lockfile.
2. Publish the official CIMD and verify browser login/refresh against the live server.
3. Configure the release-policy URL if minimum-version enforcement is required.
4. Review the latest schema candidate and validate affected commands.
5. Run CI on supported platforms and inspect `npm pack --workspace @hyper3d/cli --dry-run`.
6. Remove `private: true` from the CLI package, select the version and publish with
   `npm publish --workspace @hyper3d/cli --access public --tag latest` (or `beta`).
7. Verify the npm artifact before raising the minimum version. Keep release and
   forced-upgrade decisions separate. Set up npm trusted publishing when the
   repository publishing identity is configured; no publishing secret is stored here.

The GitHub workflow performs local, nonbillable tests and packaging checks. It
does not automatically publish or require live tokens. Convenience generation,
upload, wait and download commands are future additions over this working
generic interface; there is no separate cloud control service in this version.

References: [MCP SDK](https://ts.sdk.modelcontextprotocol.io/client),
[MCP CIMD](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#client-id-metadata-documents),
[npm install](https://docs.npmjs.com/cli/v11/commands/npm-install/).
