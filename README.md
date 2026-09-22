# Hyper3D CLI

Generate 3D models from text or images, follow their progress, and get the finished
files from your terminal.

## Install

Requires **Node.js 22 or newer**. The package is being prepared for its first npm
release; the registry commands below become available after that release.

```sh
npm install --global @hyper3d/cli
hyper3d --help
```

You can also use pnpm or Yarn, or run the CLI without a global installation:

```sh
pnpm add --global @hyper3d/cli
# Yarn Classic
yarn global add @hyper3d/cli
# Run once with npm, pnpm, or modern Yarn
npx @hyper3d/cli@latest --help
pnpm dlx @hyper3d/cli@latest --help
yarn dlx @hyper3d/cli@latest --help
```

For a project-local installation, run `npm install --save-dev @hyper3d/cli`, then
`npx hyper3d --help`. To try the latest beta build, use `@hyper3d/cli@beta`
in place of `@hyper3d/cli`.

## Sign in

```sh
hyper3d auth login
```

Compare the code shown in your terminal with the browser, then approve access.
On a remote machine, use `hyper3d auth login --no-browser` and open the printed link
on another device. Press Ctrl+C to cancel.

```sh
hyper3d auth status   # Account and credit balances
hyper3d auth logout   # Remove saved credentials from this machine
```

Credentials are saved in `~/.hyper3d` by default and refreshed automatically when
needed. Set `HYPER3D_CONFIG_DIR` to use a different directory.
Signing out locally does not revoke your server-side authorization.

## Generate a model

Generation uses credits from your authorized workspace.

```sh
# From text
hyper3d generate --prompt "a ceramic teapot" --format glb

# From one image
hyper3d generate --image ./reference.png

# From multiple views, with an optional description
hyper3d generate --image ./front.png --image ./side.jpg --prompt "a ceramic teapot"
```

Provide a prompt, one to five images, or both. Generation options:

| Option        | Accepted values                                                | Default when omitted         |
| ------------- | -------------------------------------------------------------- | ---------------------------- |
| `--tier`      | `Gen-2.5-Medium`, `Gen-2.5-High`, `Gen-2.5-Extreme-Low`        | `Gen-2.5-Medium`             |
| `--mesh-mode` | `Raw`, `Quad`                                                  | `Raw`                        |
| `--format`    | `glb`, `usdz`, `fbx`, `obj`, `stl`                             | `glb`                        |
| `--quality`   | Target polygon count: Raw `500–1,000,000`; Quad `1,000–50,000` | Raw `500,000`; Quad `18,000` |

Defaults are applied by the server. The response includes a generation ID; use
it to check progress and retrieve the result:

```sh
hyper3d status <generation-id>
hyper3d poll <generation-id> --timeout 300
hyper3d result <generation-id>
```

`poll` waits up to the requested number of seconds. `result` returns download URLs;
it does not download files to your machine.

To separate a completed model into parts:

```sh
hyper3d bang <generation-id> --instruction "separate the handle and lid"
```

| Option          | Meaning / accepted values                                                         | Default when omitted     |
| --------------- | --------------------------------------------------------------------------------- | ------------------------ |
| `--instruction` | Description of the parts to separate                                              | Automatic split planning |
| `--strength`    | Integer `1–12`; soft target for the number of parts, so the actual count may vary | `5`                      |
| `--format`      | `glb`, `usdz`, `fbx`, `obj`, `stl`                                                | `glb`                    |

Run `hyper3d <command> --help` for more options. If a generation request times out,
check your existing tasks before submitting it again; the CLI never retries
billable generation automatically.

## Use JSON output

Output is readable text by default. Add `--output json` for scripts:

```sh
hyper3d auth status --output json
hyper3d generate --prompt "a ceramic teapot" --output json
hyper3d status <generation-id> --output json
```

Warnings and errors go to stderr. Successful commands exit with code `0`; errors
exit with code `1`.

## Updates

```sh
hyper3d update --check
hyper3d update
```

An interactive **npm global installation** checks for updates once a day before
model commands and only displays an update notice by default. Stable installations
follow `latest`; prerelease-branch builds follow `beta`. Run `hyper3d update` to install
an available update.

Set `HYPER3D_AUTO_UPDATE=1` to opt into automatic installation (which asks you to
rerun your command before submitting the model operation), or
`HYPER3D_UPDATE_CHECK=0` to disable automatic checks and automatic installation.
These switches require the exact values `1` and `0`, respectively. Automatic checks
and installation are also skipped when `CI` is nonempty (including `CI=0`) or stderr
is not a TTY. These settings do not disable manual `hyper3d update` or
`hyper3d update --check`. Network failures leave your command usable.

For pnpm, Yarn, or project-local installations, update with the package manager
that installed the CLI. For one-off runs, specify `@latest`:

```sh
pnpm add --global @hyper3d/cli@latest
yarn global add @hyper3d/cli@latest  # Yarn Classic
npm install --save-dev @hyper3d/cli@latest
npx @hyper3d/cli@latest --help
```

To switch channels explicitly, install `@hyper3d/cli@latest` or
`@hyper3d/cli@beta` with your package manager. `hyper3d update` only upgrades to a
newer version and never downgrades a pinned installation.

## Troubleshooting

- **Not signed in or access denied:** run `hyper3d auth login` again. Check that you
  authorized the intended personal or team workspace.
- **Browser does not open:** follow the printed link, or use `--no-browser`.
- **Command not found:** check that your package manager's global bin directory is
  on `PATH`, or use `npx @hyper3d/cli@latest`.
- **Update permission error:** update with the package manager and permissions used
  for the original installation.
- **An interrupted update leaves future checks inactive:** close other CLI
  processes and remove the empty `update.lock` directory inside your configuration
  directory (`~/.hyper3d` by default, or the directory set by `HYPER3D_CONFIG_DIR`),
  then run `hyper3d update`.

The API base URL defaults to `https://api.hyper3d.com/api`. Set `BASE_URL` to
use another environment; a trailing slash is optional:

```sh
BASE_URL=https://api.hyper3d.com/api/ hyper3d auth status
hyper3d --base-url https://api.hyper3d.com/api auth status
```

`--base-url` overrides `BASE_URL`. MCP (`mcp`), account (`user/get_info`) and
team (`group/group_info`) endpoints are derived from this base. HTTPS is required
except for localhost. OAuth endpoints remain server-discovered, and upload/result
URLs remain server-provided.

`HYPER3D_CONFIG_DIR` changes the directory for credentials, the update cache
(`update-check.json`), and the update lock (`update.lock`). If unset, it defaults to
`~/.hyper3d`. Relative paths resolve from the current working directory; an empty
value uses the current working directory rather than the default. Use a nonempty
absolute path for a consistent location across commands.

For development and releases, see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[release guide](docs/releasing.md). Report problems in
[GitHub Issues](https://github.com/DeemosTech/hyper3d-cli/issues).
