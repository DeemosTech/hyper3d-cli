import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run via npm run test:install');
const temporary = await mkdtemp(join(tmpdir(), 'hyper3d-install-'));
const npm = (args, cwd = process.cwd()) =>
  execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', HYPER3D_UPDATE_CHECK: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
try {
  const packed = JSON.parse(
    npm([
      'pack',
      '--workspace',
      '@hyper3d/cli',
      '--pack-destination',
      temporary,
      '--json',
    ]),
  );
  const files = packed[0].files.map((file) => file.path);
  assert.ok(files.includes('dist/index.js'));
  assert.ok(files.includes('dist/base_schema.json'));
  assert.ok(files.every((file) => !file.startsWith('dist/contracts/')));
  assert.ok(
    files.every(
      (file) => !file.startsWith('src/') && !file.includes('node_modules/'),
    ),
  );
  const tarball = join(temporary, packed[0].filename);
  // Exercise npm's publication parser with the same relative artifact layout as CI.
  await mkdir(join(temporary, 'release'));
  await copyFile(tarball, join(temporary, 'release', packed[0].filename));
  const publication = JSON.parse(
    npm(
      [
        'publish',
        `./release/${packed[0].filename}`,
        '--dry-run',
        '--json',
        '--access',
        'public',
        '--tag',
        'beta',
      ],
      temporary,
    ),
  );
  // Newer npm versions group publish JSON by package name; older versions do not.
  const publishedPackage = publication[packed[0].name] ?? publication;
  assert.equal(publishedPackage.id, packed[0].id);
  assert.equal(publishedPackage.integrity, packed[0].integrity);
  const prefix = join(temporary, 'global');
  npm([
    'install',
    '--global',
    '--prefix',
    prefix,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    tarball,
  ]);
  const bin =
    process.platform === 'win32'
      ? join(prefix, 'node_modules/@hyper3d/cli/dist/index.js')
      : join(prefix, 'bin/hyper3d');
  const expected = JSON.parse(
    await readFile('packages/cli/package.json', 'utf8'),
  ).version;
  assert.equal(
    execFileSync(process.execPath, [bin, '--version'], {
      encoding: 'utf8',
    }).trim(),
    expected,
  );
  assert.match(
    execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' }),
    /generate/,
  );
  const consumer = join(temporary, 'consumer');
  await mkdir(consumer);
  npm(['init', '--yes'], consumer);
  npm(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
    consumer,
  );
  assert.equal(
    npm(['exec', '--offline', '--', 'hyper3d', '--version'], consumer).trim(),
    expected,
  );
  // Isolated npm exec/npx path: proves the packed bin works without a project install.
  const empty = join(temporary, 'empty');
  await mkdir(empty);
  assert.equal(
    npm(
      [
        'exec',
        '--yes',
        `--package=${resolve(tarball)}`,
        '--',
        'hyper3d',
        '--version',
      ],
      empty,
    ).trim(),
    expected,
  );
  const managers = join(temporary, 'managers');
  npm([
    'install',
    '--prefix',
    managers,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    'pnpm@10',
    'yarn@1.22.22',
  ]);
  for (const [name, entry] of [
    ['pnpm', 'bin/pnpm.cjs'],
    ['yarn', 'bin/yarn.js'],
  ]) {
    const project = join(temporary, name);
    await mkdir(project);
    npm(['init', '--yes'], project);
    const execute = (args) =>
      execFileSync(
        process.execPath,
        [join(managers, 'node_modules', name, entry), ...args],
        {
          cwd: project,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'inherit'],
          env: {
            ...process.env,
            CI: '1',
            HYPER3D_UPDATE_CHECK: '0',
            YARN_CACHE_FOLDER: join(temporary, 'yarn-cache'),
          },
        },
      );
    execute(['add', '--ignore-scripts', tarball]);
    const output = execute(
      name === 'pnpm'
        ? ['exec', 'hyper3d', '--version']
        : ['--silent', 'run', 'hyper3d', '--version'],
    );
    assert.equal(output.trim(), expected);
  }
  console.log(
    'Tarball publication dry-run, npm global/local/one-off execution, pnpm and Yarn installs passed.',
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
