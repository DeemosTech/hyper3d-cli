# Contributing

Use Node.js 22+ and npm. `main` is the current integration branch. Create a feature
or fix branch and open a pull request targeting `main`; do not develop directly
on main.

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
