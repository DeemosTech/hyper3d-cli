#!/usr/bin/env node
import {Command} from 'commander';
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {withClient, listTools} from './mcp.js';
import {compareTool, validateInput} from './schema.js';
import {checkUpdate, update, startupUpdate} from './update.js';
import {clientMetadata, login, logout, loadCredentials} from './auth.js';
import {enforcePolicy} from './policy.js';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const baseline = JSON.parse(await readFile(new URL('../schema/tools.json', import.meta.url), 'utf8'));
const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const cli = new Command().name('hyper3d').version(pkg.version)
  .option('--endpoint <url>', 'MCP endpoint', process.env.HYPER3D_MCP_URL ?? 'https://api.hyper3d.com/api/mcp');
const connect = action => withClient({endpoint: cli.opts().endpoint, token: process.env.HYPER3D_ACCESS_TOKEN, version: pkg.version}, action);
cli.hook('preAction', async (_root, command) => {
  if (command.name() === 'call') {
    if (await startupUpdate(pkg, fileURLToPath(new URL('..', import.meta.url)))) throw new Error('CLI updated; rerun your command.');
    await enforcePolicy(process.env.HYPER3D_RELEASE_POLICY_URL ?? pkg.hyper3d?.releasePolicyUrl, pkg.version);
  }
});
const authentication = cli.command('auth');
authentication.command('metadata').requiredOption('--client-id <url>', 'Public HTTPS CIMD URL').action(options => print(clientMetadata(options.clientId)));
authentication.command('login').option('--client-id <url>', 'Public HTTPS CIMD URL', process.env.HYPER3D_CLIENT_ID)
  .action(async options => { await login(cli.opts().endpoint, options.clientId); print({authenticated: true}); });
authentication.command('logout').action(async () => { await logout(cli.opts().endpoint); print({localCredentialsRemoved: true}); });
authentication.command('status').action(async () => {
  const data = await loadCredentials(cli.opts().endpoint);
  print({credentialSource: process.env.HYPER3D_ACCESS_TOKEN ? 'environment' : data.tokens ? 'file' : 'none', clientId: data.clientId, expiresAt: data.expiresAt, verified: false});
});
const tools = cli.command('tools').description('Discover and call remote MCP tools');
tools.command('list').action(() => connect(async client => print(await listTools(client))));
tools.command('describe <name>').action(name => connect(async client => {
  const tool = (await listTools(client)).find(t => t.name === name);
  if (!tool) throw new Error(`Tool unavailable: ${name}`);
  print(tool);
}));
tools.command('call <name>').option('--json <value>', 'JSON input').option('--json-file <path>', 'JSON input file')
  .action((name, options) => connect(async client => {
    if (options.json !== undefined && options.jsonFile) throw new Error('Choose --json or --json-file');
    const input = JSON.parse(options.jsonFile ? await readFile(options.jsonFile, 'utf8') : options.json ?? '{}');
    const remote = (await listTools(client)).find(t => t.name === name);
    const local = baseline.tools.find(t => t.name === name);
    if (!local) process.stderr.write(`warning: ${name} has no bundled baseline; validating against remote schema.\n`);
    for (const change of compareTool(local, remote))
      process.stderr.write(`warning: ${name} ${change.path}: ${change.reason} (${change.severity})\n`);
    if (!remote) throw new Error(`Tool unavailable: ${name}`);
    validateInput(remote.inputSchema, input);
    // Exactly one call. Never retry potentially billable generation requests.
    const result = await client.callTool({name, arguments: input}, undefined, {timeout: 60000});
    print(result);
    if (result.isError) process.exitCode = 1;
  }));
const schema = cli.command('schema');
schema.command('check').action(() => connect(async client => {
  const remote = await listTools(client);
  const changes = baseline.tools.flatMap(tool => compareTool(tool, remote.find(t => t.name === tool.name)).map(c => ({tool: tool.name, ...c})));
  print({source: baseline.source, changes, addedTools: remote.filter(t => !baseline.tools.some(b => b.name === t.name)).map(t => t.name)});
  if (changes.length) process.exitCode = 2;
}));
schema.command('snapshot').requiredOption('--out <path>', 'Write candidate snapshot for review; does not replace bundled baseline automatically')
  .action(options => connect(async client => {
    const snapshot = {source: cli.opts().endpoint, capturedAt: new Date().toISOString(), tools: await listTools(client)};
    await writeFile(options.out, `${JSON.stringify(snapshot, null, 2)}\n`, {flag: 'wx'});
    print({written: options.out});
  }));
cli.command('update').option('--check', 'Only check npm').option('--channel <channel>', 'latest or beta', 'latest')
  .action(async options => print(options.check ? await checkUpdate(pkg, options.channel) : await update(pkg, fileURLToPath(new URL('..', import.meta.url)), options.channel)));

try { await cli.parseAsync(); }
catch (error) {
  let message = error instanceof Error ? error.message : 'Request failed';
  if (process.env.HYPER3D_ACCESS_TOKEN) message = message.replaceAll(process.env.HYPER3D_ACCESS_TOKEN, '[REDACTED]');
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}
