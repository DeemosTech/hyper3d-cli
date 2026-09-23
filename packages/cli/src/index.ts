#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Command, Option } from 'commander';

import { accountInfo } from './account.js';
import { login, logout } from './auth.js';
import {
  DEFAULT_BASE_URL,
  configureEndpoints,
  endpoints,
} from './endpoints.js';
import { generate, status, result, poll, bang } from './operations.js';
import { formatOutput } from './output.js';
import { checkUpdate, update, startupUpdate, updateChannel } from './update.js';
import { getConfigDir } from './utils.js';

import type { Payload } from './types.js';

const pkg = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);

const print = (value: Payload, kind?: string) => {
  process.stdout.write(
    `${formatOutput(value, { format: cli.opts().output, kind })}\n`,
  );
};

const cli = new Command('hyper3d').version(pkg.version);
cli.option(
  '--base-url <url>',
  'Hyper3D API base URL (overrides BASE_URL)',
  process.env.BASE_URL ?? DEFAULT_BASE_URL,
);
cli.addOption(
  new Option('--output <format>', 'Output format')
    .choices(['human', 'json'])
    .default('human'),
);

cli.hook('preAction', () => {
  configureEndpoints(cli.opts().baseUrl);
});

cli.hook('preAction', async (_root, command) => {
  if (
    command.parent !== cli ||
    !['generate', 'status', 'poll', 'result', 'bang'].includes(command.name())
  )
    return;
  if (
    process.env.CI ||
    !process.stderr.isTTY ||
    process.env.HYPER3D_UPDATE_CHECK === '0'
  )
    return;

  const updated = await startupUpdate(pkg, {
    autoUpdate: process.env.HYPER3D_AUTO_UPDATE === '1',
    cacheDir: getConfigDir(),
  });
  if (updated) throw new Error('CLI updated; rerun your command.');
});

// auth
const authentication = cli.command('auth');
authentication
  .command('login')
  .option(
    '--no-browser',
    'Print the verification link and code without opening a browser',
  )
  .action(async (options) => {
    await login(endpoints.mcp, { browser: options.browser });
    print({ authenticated: true }, 'auth-login');
  });
authentication.command('logout').action(async () => {
  await logout(endpoints.mcp);
  print({ localCredentialsRemoved: true }, 'auth-logout');
});

authentication
  .command('status')
  .alias('info')
  .description('Show your account and authorized wallet credit balances')
  .action(async () => print(await accountInfo(), 'account'));

// generate
cli
  .command('generate')
  .description('Generate a model from text and/or local reference images')
  .option('--prompt <text>', 'Model description; required without --image')
  .option(
    '--image <path>',
    'Reference image; repeat for up to five images; required without --prompt',
    (path: string, paths: string[]) => [...paths, path],
    [],
  )
  .option(
    '--tier <tier>',
    'Generation tier: Gen-2.5-Medium, Gen-2.5-High, Gen-2.5-Extreme-Low (server default: Gen-2.5-Medium)',
  )
  .option('--mesh-mode <mode>', 'Mesh mode: Raw, Quad (server default: Raw)')
  .option(
    '--texture-delight',
    'Enable texture de-lighting; recommended for highly reflective reference images (server default: false)',
  )
  .option(
    '--format <format>',
    'Geometry format: glb, usdz, fbx, obj, stl (server default: glb)',
  )
  .option(
    '--quality <count>',
    'Target polygon count: Raw 500-1,000,000, Quad 1,000-50,000 (server default: Raw 500,000, Quad 18,000)',
    Number,
  )
  .action(async (options) => print(await generate(options)));

// poll
for (const [command, action] of [
  ['status', status],
  ['result', result],
] as const) {
  cli
    .command(`${command} <generation-id>`)
    .action(async (id) => print(await action(id)));
}

cli
  .command('poll <generation-id>')
  .description('Poll until generation finishes or the timeout expires')
  .option('--timeout <seconds>', 'Total polling timeout in seconds', Number, 30)
  .action(async (id, options) => print(await poll(id, options.timeout)));

// bang
cli
  .command('bang <generation-id>')
  .description('Run BANG to separate a completed model into parts')
  .option(
    '--instruction <text>',
    'Parts to separate; omit for automatic split planning',
  )
  .option(
    '--strength <count>',
    'Soft target part count, 1-12; actual count may vary (server default: 5)',
    Number,
  )
  .option(
    '--format <format>',
    'Geometry format: glb, usdz, fbx, obj, stl (server default: glb)',
  )
  .action(async (id, options) => print(await bang(id, options)));

// update
cli
  .command('update')
  .option('--check', 'Only check npm')
  .option('--channel <channel>', 'latest, next or beta', updateChannel(pkg))
  .action(async (options) =>
    print(
      options.check
        ? await checkUpdate(pkg, options.channel)
        : await update(
            pkg,
            fileURLToPath(new URL('..', import.meta.url)),
            options.channel,
          ),
    ),
  );

try {
  await cli.parseAsync();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Request failed';
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}
