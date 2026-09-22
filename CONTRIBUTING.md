# Contributing

Use Node.js 22+ and npm. Create development branches from `prerelease` and open
feature/fix pull requests targeting `prerelease`. Only the repository's
`prerelease` branch may open a release PR targeting `main`.

CI enforces development version >= prerelease and the resulting prerelease
version > main. Release PRs require prerelease version > main. Source versions
must be stable `X.Y.Z` values and match `package-lock.json`; beta suffixes are
added only during publishing. After a stable release, bump the target version in
the next development PR, for example:

```sh
npm version 0.1.1 --workspace @hyper3d/cli --no-git-tag-version
```

PRs run CI once; pushing a development branch without a PR does not trigger CI.
Use a draft PR for early checks. New PR commits cancel obsolete checks. Merge
commits when promoting prerelease to main preserve the shared branch history.

```sh
npm ci
npm run cli -- --help
npm run format
npm run lint
npm run typecheck
npm test
npm run test:install
```

The CLI source is in `packages/cli/src`, written in strict TypeScript and compiled
to `packages/cli/dist`. Tests exercise the compiled JavaScript. The build copies
contract JSON into the artifact; consumers do not need TypeScript or install
scripts. Do not commit `dist`.

ESLint and Prettier follow the Hyper3D backend configuration: 80-column formatting,
single quotes, trailing commas, sorted import groups, unused-import checks and
type-aware promise rules. NestJS-specific rules do not apply to this CLI.
`npm run lint:fix` fixes lint issues; `npm run format:check` checks formatting
without changing files. Tests and maintenance scripts are linted as JavaScript.

CI checks formatting, lint, types, unit/integration tests, and actual packed
installations on Linux, macOS and Windows with Node.js 22 and 24. Tests use local
servers and fixtures; no production credentials or billable operations are needed.

`npm run test:install` packs the CLI, installs it into temporary global and local
prefixes, and exercises its executable and one-off npm execution. It also verifies
pnpm 10 and Yarn Classic installations. It downloads
normal npm dependencies and removes its temporary installations afterward.

For integration details, see [architecture.md](docs/architecture.md).
For publishing and repository protection, see [releasing.md](docs/releasing.md).
