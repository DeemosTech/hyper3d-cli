# Hyper3D CLI

Generate Rodin Gen-2.5 3D models from text or reference images, split completed
models into parts with BANG, and retrieve download links from your terminal.
Use readable output interactively or JSON output in scripts.

## Install

Requires **Node.js 22 or newer** and a Hyper3D account. Install the stable release:

```sh
npm install --global @hyper3d/cli@latest
hyper3d --version
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
`npx hyper3d --help`. For preview builds or switching from beta to stable, see
[Updates](#updates).

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

Generation uses credits from the personal or team workspace you authorized at
sign-in. Run `hyper3d auth status` to check that workspace and its credit balances.

```sh
# From text
hyper3d generate --prompt "a ceramic teapot" --format glb

# From one image
hyper3d generate --image ./reference.png

# For reference images with highly reflective surfaces
hyper3d generate --image ./reference.png --texture-delight

# From multiple views, with an optional description
hyper3d generate --image ./front.png --image ./side.jpg --prompt "a ceramic teapot"
```

Provide a prompt, one to five images, or both. Generation options:

| Option              | Accepted values                                                         | Default when omitted         |
| ------------------- | ----------------------------------------------------------------------- | ---------------------------- |
| `--tier`            | `Gen-2.5-Medium`, `Gen-2.5-High`, `Gen-2.5-Extreme-Low`                 | `Gen-2.5-Medium`             |
| `--mesh-mode`       | `Raw`, `Quad`                                                           | `Raw`                        |
| `--format`          | `glb`, `usdz`, `fbx`, `obj`, `stl`                                      | `glb`                        |
| `--quality`         | Target polygon count: Raw `500–1,000,000`; Quad `1,000–50,000`          | Raw `500,000`; Quad `18,000` |
| `--texture-delight` | Flag: enable texture de-lighting for highly reflective reference images | `false`                      |

Defaults are applied by the server. The response includes a generation ID; use
it in place of `<generation-id>` to check progress and retrieve the result:

```sh
hyper3d status <generation-id>
hyper3d poll <generation-id> --timeout 300
hyper3d result <generation-id>
```

`status` checks progress once. `poll` waits until generation finishes or the
timeout expires (30 seconds by default). A polling timeout does not cancel the
generation; run `status` or `poll` again to keep following it. Once generation
completes, `result` returns download URLs; it does not save files to your machine.

## Split a model with BANG

Pass a completed model's generation ID to BANG. Omit `--instruction` for automatic
split planning, or describe the parts you want to separate:

```sh
hyper3d bang <generation-id> --instruction "separate the handle and lid"
```

| Option          | Meaning / accepted values                                                         | Default when omitted     |
| --------------- | --------------------------------------------------------------------------------- | ------------------------ |
| `--instruction` | Description of the parts to separate                                              | Automatic split planning |
| `--strength`    | Integer `1–12`; soft target for the number of parts, so the actual count may vary | `5`                      |
| `--format`      | `glb`, `usdz`, `fbx`, `obj`, `stl`                                                | `glb`                    |

BANG uses credits and returns a new generation ID. Use that new ID with `status`,
`poll`, and `result` to follow the split and retrieve its output.

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

For a global npm installation:

```sh
hyper3d update --check
hyper3d update
```

`update --check` reports the installed version, the channel's target version, and
whether an update is available. `update` installs it when the target is newer.
Stable versions follow `latest`; beta versions follow `beta`.

An interactive **npm global installation** checks for updates once a day before
model commands and only displays an update notice by default.

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

Beta installations continue following beta after a stable release. To switch
channels explicitly, install the desired tag with your package manager:

```sh
# Switch to the stable release, including from beta
npm install --global @hyper3d/cli@latest

# Opt into beta builds
npm install --global @hyper3d/cli@beta
```

`hyper3d update` only installs newer versions. Reinstalling a tag explicitly also
lets you switch to a channel whose current version is older than yours.

## Configuration

The defaults work with the public Hyper3D service. To use another environment:

```sh
hyper3d --base-url https://api.hyper3d.com/api auth status
```

| Setting                | Purpose                                                           | Default                       |
| ---------------------- | ----------------------------------------------------------------- | ----------------------------- |
| `BASE_URL`             | API base URL; `--base-url` takes precedence                       | `https://api.hyper3d.com/api` |
| `HYPER3D_CONFIG_DIR`   | Directory for credentials and update state                        | `~/.hyper3d`                  |
| `HYPER3D_AUTO_UPDATE`  | Set to `1` to install updates automatically before model commands | Disabled                      |
| `HYPER3D_UPDATE_CHECK` | Set to `0` to disable automatic update checks and installation    | Enabled                       |

API URLs require HTTPS except for localhost. Use a nonempty absolute path when
setting `HYPER3D_CONFIG_DIR`.

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

## Contributing and support

For development and releases, see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[release guide](docs/releasing.md). Report problems in
[GitHub Issues](https://github.com/DeemosTech/hyper3d-cli/issues).
