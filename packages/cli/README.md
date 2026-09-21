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
`npx hyper3d --help`. To try the latest main-branch build, use `@hyper3d/cli@next`
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

Credentials are saved in `~/.hyper3d` and refreshed automatically when needed.
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

You can provide up to five images. The response includes a generation ID; use it
to check progress and retrieve the result:

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
model commands and installs newer versions automatically. Stable installations
follow `latest`; main-branch builds follow `next`. After an automatic update, the
CLI asks you to rerun your command. The model operation has not been submitted.

Set `HYPER3D_AUTO_UPDATE=0` to receive update notices without installing, or
`HYPER3D_UPDATE_CHECK=0` to disable automatic checks. CI and noninteractive scripts
do not auto-update. Network failures leave your command usable.

For pnpm, Yarn, or project-local installations, update with the package manager
that installed the CLI. For one-off runs, specify `@latest`:

```sh
pnpm add --global @hyper3d/cli@latest
yarn global add @hyper3d/cli@latest  # Yarn Classic
npm install --save-dev @hyper3d/cli@latest
npx @hyper3d/cli@latest --help
```

To switch channels explicitly, install `@hyper3d/cli@latest` or
`@hyper3d/cli@next` with your package manager. `hyper3d update` only upgrades to a
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
  processes and remove the empty `~/.hyper3d/update.lock` directory, then run
  `hyper3d update`.

Use `--endpoint <url>` for a custom Hyper3D MCP endpoint. HTTPS is required except
for localhost. `HYPER3D_CONFIG_DIR` changes the credential and update-cache directory.

For development and releases, see [CONTRIBUTING.md](https://github.com/DeemosTech/hyper3d-cli/blob/main/CONTRIBUTING.md) and the
[release guide](https://github.com/DeemosTech/hyper3d-cli/blob/main/docs/releasing.md). Report problems in
[GitHub Issues](https://github.com/DeemosTech/hyper3d-cli/issues).
