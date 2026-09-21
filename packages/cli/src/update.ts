import { execFile } from 'node:child_process';
import {
  lstat,
  realpath,
  readFile,
  mkdir,
  writeFile,
  access,
  rm,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { promisify } from 'node:util';

import semver from 'semver';

import type { PackageInfo } from './types.js';

const exec = promisify(execFile);
export type Runner = (args: string[]) => Promise<string>;
export async function npm(args: string[]) {
  if (process.platform === 'win32') {
    // Execute npm's JS entry point directly, without a shell or npm.cmd quoting.
    const candidates = [
      process.env.npm_execpath,
      ...[
        dirname(process.execPath),
        ...(process.env.PATH ?? '').split(delimiter),
      ].map((path) => join(path, 'node_modules', 'npm', 'bin', 'npm-cli.js')),
    ];
    for (const path of candidates) {
      if (!path?.endsWith('npm-cli.js')) continue;
      try {
        await access(path);
      } catch {
        continue;
      }
      return (
        await exec(process.execPath, [path, ...args], { timeout: 120000 })
      ).stdout;
    }
    throw new Error(
      'Cannot find npm. Install Node.js with npm, then run npm install -g @hyper3d/cli@latest.',
    );
  }
  return (await exec('npm', args, { timeout: 120000 })).stdout;
}
export function updateChannel(pkg: PackageInfo): string {
  return String(semver.prerelease(pkg.version)?.[0] ?? 'latest');
}
function validateChannel(channel: string) {
  if (!['latest', 'next', 'beta'].includes(channel))
    throw new Error('Channel must be latest, next or beta');
}
export async function checkUpdate(
  pkg: PackageInfo,
  channel: string,
  run: Runner = npm,
) {
  validateChannel(channel);
  const target: unknown = JSON.parse(
    await run([
      'view',
      `${pkg.name}@${channel}`,
      'version',
      '--json',
      '--fetch-retries=0',
      '--fetch-timeout=5000',
    ]),
  );
  if (typeof target !== 'string' || !semver.valid(target))
    throw new Error('npm returned an invalid version');
  return {
    current: pkg.version,
    target,
    available: semver.gt(target, pkg.version),
  };
}
export async function isGlobalInstall(
  pkg: PackageInfo,
  directory: string,
  run: Runner = npm,
) {
  const root = (await run(['root', '-g'])).trim();
  try {
    if ((await lstat(join(root, pkg.name))).isSymbolicLink()) return false;
    return (
      (await realpath(join(root, pkg.name))) === (await realpath(directory))
    );
  } catch {
    return false;
  }
}
export async function update(
  pkg: PackageInfo,
  directory: string,
  channel: string,
  run: Runner = npm,
) {
  validateChannel(channel);
  if (pkg.private)
    throw new Error(
      'This development package is private; npm publishing is not configured yet.',
    );
  if (!(await isGlobalInstall(pkg, directory, run)))
    throw new Error(
      `Not a global npm installation. Use your package manager to update ${pkg.name}@${channel}; for one-off use run npx ${pkg.name}@${channel}.`,
    );
  const result = await checkUpdate(pkg, channel, run);
  if (result.available)
    await run([
      'install',
      '--global',
      `${pkg.name}@${result.target}`,
      '--no-fund',
      '--no-audit',
    ]);
  return { ...result, updated: result.available };
}

interface StartupOptions {
  run?: Runner;
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  now?: () => number;
  write?: (message: string) => unknown;
}
export async function startupUpdate(
  pkg: PackageInfo,
  directory: string,
  {
    run = npm,
    env = process.env,
    interactive = Boolean(process.stderr.isTTY),
    now = Date.now,
    write = (message) => process.stderr.write(message),
  }: StartupOptions = {},
) {
  if (pkg.private || env.CI || !interactive || env.HYPER3D_UPDATE_CHECK === '0')
    return false;
  const channel = updateChannel(pkg);
  const cacheDir = env.HYPER3D_CONFIG_DIR ?? join(homedir(), '.hyper3d');
  const cachePath = join(cacheDir, 'update-check.json');
  const lockPath = join(cacheDir, 'update.lock');
  let locked = false;
  try {
    // Never change workspace, npx, pnpm or Yarn installations with npm.
    if (!(await isGlobalInstall(pkg, directory, run))) return false;
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    try {
      await mkdir(lockPath, { mode: 0o700 });
      locked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    let cached: {
      name?: string;
      version?: string;
      channel?: string;
      checkedAt?: number;
    } = {};
    try {
      cached = JSON.parse(await readFile(cachePath, 'utf8'));
    } catch {
      /* first run */
    }
    const checkedAt = now();
    if (
      cached?.name === pkg.name &&
      cached?.version === pkg.version &&
      cached?.channel === channel &&
      typeof cached.checkedAt === 'number' &&
      checkedAt - cached.checkedAt >= 0 &&
      checkedAt - cached.checkedAt < 86400000
    )
      return false;
    // Cache failures too: offline operation must not repeatedly wait on the registry.
    await writeFile(
      cachePath,
      JSON.stringify({
        name: pkg.name,
        version: pkg.version,
        channel,
        checkedAt,
      }),
      { mode: 0o600 },
    );
    const result = await checkUpdate(pkg, channel, run);
    if (!result.available) return false;
    if (env.HYPER3D_AUTO_UPDATE !== '0') {
      await run([
        'install',
        '--global',
        `${pkg.name}@${result.target}`,
        '--no-fund',
        '--no-audit',
      ]);
      write(
        `Updated to ${result.target}. Run your command again; it has not been executed.\n`,
      );
      return true;
    }
    write(`Update available: ${result.target}. Run hyper3d update.\n`);
  } catch {
    write(
      'warning: Automatic update check/install failed. Use hyper3d update to inspect.\n',
    );
  } finally {
    if (locked)
      await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
  return false;
}
