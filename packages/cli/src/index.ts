#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Command, Option } from 'commander';

import { accountInfo } from './account.js';
import { login, logout } from './auth.js';
import { currentContractVersion, getContract } from './contracts/index.js';
import { DEFAULT_BASE_URL, resolveEndpoints } from './endpoints.js';
import { withClient, listTools } from './mcp.js';
import { createOperations } from './operations.js';
import { formatOutput } from './output.js';
import { enforcePolicy } from './policy.js';
import { checkUpdate, update, startupUpdate, updateChannel } from './update.js';

import type { Payload } from './types.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

const pkg = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const selectedContract = () => getContract(cli.opts().schemaVersion);
const print = (value: Payload, kind?: string) => {
  process.stdout.write(
    `${formatOutput(value, { format: cli.opts().output, kind })}\n`,
  );
};
const cli = new Command()
  .name('hyper3d')
  .version(pkg.version)
  .option(
    '--schema-version <version>',
    'Operation contract version',
    currentContractVersion,
  )
  .option(
    '--base-url <url>',
    'Hyper3D API base URL (overrides BASE_URL)',
    process.env.BASE_URL ?? DEFAULT_BASE_URL,
  )
  .addOption(
    new Option('--output <format>', 'Output format')
      .choices(['human', 'json'])
      .default('human'),
  );
const endpoints = () => resolveEndpoints(cli.opts().baseUrl);
const connect = async (action: (client: Client) => Promise<void>) =>
  withClient({ endpoint: endpoints().mcp, version: pkg.version }, action);
cli.hook('preAction', async (_root, command) => {
  if (
    command.parent === cli &&
    ['generate', 'status', 'poll', 'result', 'bang'].includes(command.name())
  ) {
    if (await startupUpdate(pkg, fileURLToPath(new URL('..', import.meta.url))))
      throw new Error('CLI updated; rerun your command.');
    await enforcePolicy(
      process.env.HYPER3D_RELEASE_POLICY_URL ?? pkg.hyper3d?.releasePolicyUrl,
      pkg.version,
    );
  }
});
const authentication = cli.command('auth');
authentication
  .command('login')
  .option(
    '--no-browser',
    'Print the verification link and code without opening a browser',
  )
  .action(async (options) => {
    await login(endpoints().mcp, { browser: options.browser });
    print({ authenticated: true }, 'auth-login');
  });
authentication.command('logout').action(async () => {
  await logout(endpoints().mcp);
  print({ localCredentialsRemoved: true }, 'auth-logout');
});
authentication
  .command('status')
  .alias('info')
  .description('Show your account and authorized wallet credit balances')
  .action(async () => print(await accountInfo(endpoints().baseUrl), 'account'));
const operation = async (
  action: (ops: ReturnType<typeof createOperations>) => Promise<void>,
) => {
  const contract = selectedContract();
  return connect(async (client) =>
    action(createOperations(client, contract, await listTools(client))),
  );
};
cli
  .command('generate')
  .description('Generate a model from text and/or local reference images')
  .option('--prompt <text>', 'Model description')
  .option(
    '--image <path>',
    'Reference image; repeat for up to five images',
    (path: string, paths: string[]) => [...paths, path],
    [],
  )
  .option('--tier <tier>', 'Generation tier')
  .option('--mesh-mode <mode>', 'Mesh mode, e.g. Raw or Quad')
  .option('--format <format>', 'Geometry format, e.g. glb')
  .option('--quality <count>', 'Target polygon count', Number)
  .action(async (options) =>
    operation(async (ops) => print(await ops.generate(options))),
  );
for (const [command, tool] of [
  ['status', 'rodin_get_status'],
  ['result', 'rodin_get_result'],
]) {
  cli
    .command(`${command} <generation-id>`)
    .action(async (id) =>
      operation(async (ops) =>
        print(await ops.call(tool, { generation_id: id })),
      ),
    );
}
cli
  .command('poll <generation-id>')
  .description('Poll until generation finishes or the timeout expires')
  .option('--timeout <seconds>', 'Total polling timeout in seconds', Number, 30)
  .action(async (id, options) =>
    operation(async (ops) => print(await ops.poll(id, options.timeout))),
  );
cli
  .command('bang <generation-id>')
  .description('Run BANG to separate a completed model into parts')
  .option('--instruction <text>', 'Parts to separate')
  .option('--strength <count>', 'Target part count', Number)
  .option('--format <format>', 'Geometry format')
  .action(async (id, options) =>
    operation(async (ops) =>
      print(
        await ops.call(
          'rodin_generate_bang',
          Object.fromEntries(
            Object.entries({
              asset_id: id,
              instruction: options.instruction,
              strength: options.strength,
              geometry_file_format: options.format,
            }).filter(([, value]) => value !== undefined),
          ),
        ),
      ),
    ),
  );
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
