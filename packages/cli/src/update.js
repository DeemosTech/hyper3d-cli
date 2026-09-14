import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import semver from 'semver';

const exec = promisify(execFile);
export async function npm(args) {
  // No shell interpolation; npm.cmd cannot be executed this way on Windows.
  if (process.platform === 'win32') {
    if (!process.env.npm_execpath?.endsWith('npm-cli.js'))
      throw new Error('On Windows run npm install -g @hyper3d/cli@latest to update.');
    return (await exec(process.execPath, [process.env.npm_execpath, ...args], {timeout: 120000})).stdout;
  }
  return (await exec('npm', args, {timeout: 120000})).stdout;
}
export async function checkUpdate(pkg, channel, run = npm) {
  if (!['latest', 'beta'].includes(channel)) throw new Error('Channel must be latest or beta');
  const target = JSON.parse(await run(['view', `${pkg.name}@${channel}`, 'version', '--json', '--fetch-retries=0', '--fetch-timeout=5000']));
  if (!semver.valid(target)) throw new Error('npm returned an invalid version');
  return {current: pkg.version, target, available: semver.gt(target, pkg.version)};
}
export async function update(pkg, directory, channel, run = npm) {
  if (!['latest', 'beta'].includes(channel)) throw new Error('Channel must be latest or beta');
  if (pkg.private) throw new Error('This development package is private; npm publishing is not configured yet.');
  const root = (await run(['root', '-g'])).trim();
  let installed;
  try { installed = await realpath(join(root, pkg.name)); } catch { /* not global */ }
  if (!installed || installed !== await realpath(directory))
    throw new Error(`Not a global npm installation. Update your dependency with npm install ${pkg.name}@${channel}`);
  const result = await checkUpdate(pkg, channel, run);
  if (result.available) await run(['install', '--global', `${pkg.name}@${result.target}`, '--no-fund', '--no-audit']);
  return {...result, updated: result.available};
}

export async function startupUpdate(pkg, directory) {
  // Development builds, CI and noninteractive scripts never mutate themselves.
  if (pkg.private || process.env.CI || !process.stderr.isTTY || process.env.HYPER3D_UPDATE_CHECK === '0') return false;
  const cacheDir = process.env.HYPER3D_CONFIG_DIR ?? join(homedir(), '.hyper3d');
  const cachePath = join(cacheDir, 'update-check.json');
  let cached;
  try { cached = JSON.parse(await readFile(cachePath, 'utf8')); } catch { /* first run */ }
  const now = Date.now();
  if (cached?.name === pkg.name && cached?.version === pkg.version && now - cached.checkedAt >= 0 && now - cached.checkedAt < 86400000) return false;
  try {
    const result = await checkUpdate(pkg, 'latest');
    await mkdir(cacheDir, {recursive: true, mode: 0o700});
    await writeFile(cachePath, JSON.stringify({name: pkg.name, version: pkg.version, checkedAt: now}), {mode: 0o600});
    if (!result.available) return false;
    if (process.env.HYPER3D_AUTO_UPDATE === '1') {
      const installed = await update(pkg, directory, 'latest');
      if (installed.updated) {
        process.stderr.write(`Updated to ${installed.target}. Run your command again; it has not been executed.\n`);
        return true;
      }
    }
    process.stderr.write(`Update available: ${result.target}. Run hyper3d update.\n`);
  } catch { process.stderr.write('warning: Automatic update check/install failed. Use hyper3d update to inspect.\n'); }
  return false;
}
