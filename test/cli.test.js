import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const executable = fileURLToPath(
  new URL('../packages/cli/dist/index.js', import.meta.url),
);
const exec = promisify(execFile);
test('CLI against real HTTP MCP: named operations, public commands, error exits and no retry', async () => {
  let calls = 0;
  let catalogAvailable = true;
  const animation = {
    animation_id: 'human_000093',
    category: 'human',
    display_name: 'Walking',
    content_description: 'Walk forward',
    frames: 31,
    duration_seconds: 1,
    loop: {
      kind: 'travel',
      alignment: 'next',
      period_frames: 30,
      displacement: [0, 0, 1],
    },
  };
  const catalogInputs = [];

  const requests = [];
  const { version } = JSON.parse(
    await readFile(
      new URL('../packages/cli/package.json', import.meta.url),
      'utf8',
    ),
  );
  const config = await mkdtemp(join(tmpdir(), 'hyper3d-cli-'));
  const server = createServer(async (req, res) => {
    const mcp = new McpServer({ name: 'fixture', version: '1.0.0' });
    mcp.registerTool(
      'rodin_wait',
      {
        inputSchema: {
          generation_id: z.string(),
          timeout_seconds: z.number().int().min(1).max(45),
        },
      },
      async () => {
        calls++;
        return {
          content: [{ type: 'text', text: 'test failure' }],
          isError: true,
        };
      },
    );
    mcp.registerTool(
      'rodin_generate',
      {
        inputSchema: {
          prompt: z.string(),
          tier: z.enum(['Future']).optional(),
        },
      },
      async ({ prompt }) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ generation_id: 'test-generation', prompt }),
          },
        ],
      }),
    );
    mcp.registerTool(
      'rodin_generate_polygen',
      {
        inputSchema: {
          asset_id: z.string().uuid(),
          face_count: z.number().int().min(200).max(20000).optional(),
          quad_normal: z.boolean().optional(),
          hd_texture: z.boolean().optional(),
        },
      },
      async (input) => ({
        content: [{ type: 'text', text: JSON.stringify(input) }],
      }),
    );
    for (const name of [
      'rodin_generate_rigging',
      'rodin_list_animation_presets',
    ]) {
      mcp.registerTool(
        name,
        {
          inputSchema: {
            asset_id: z.string().optional(),
            bone_template: z.string().optional(),
            animation_preset: z.array(z.string()).optional(),
            category: z.string().optional(),
          },
        },
        async (input) => ({
          content: [{ type: 'text', text: JSON.stringify(input) }],
        }),
      );
    }
    if (catalogAvailable)
      mcp.registerTool(
        'rodin_list_animation_catalog',
        {
          inputSchema: { category: z.string().optional() },
          outputSchema: {
            categories: z.array(
              z.object({
                category: z.string(),
                animations: z.array(
                  z.object({
                    animation_id: z.string(),
                    category: z.string(),
                    display_name: z.string(),
                    content_description: z.string(),
                    frames: z.number().int(),
                    duration_seconds: z.number(),
                    loop: z.object({
                      kind: z.string(),
                      alignment: z.string(),
                      period_frames: z.number().nullable(),
                      displacement: z.array(z.number()),
                    }),
                  }),
                ),
              }),
            ),
          },
        },
        async (input) => {
          catalogInputs.push(input);
          const data = {
            categories:
              !input.category || ['human', 'human_sp'].includes(input.category)
                ? [{ category: 'human', animations: [animation] }]
                : [],
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(data) }],
            structuredContent: data,
          };
        },
      );
    mcp.registerTool(
      'rodin_list_uploads',
      {
        inputSchema: {
          kind: z.string().optional(),
          tag: z.string().optional(),
          page: z.number().optional(),
        },
      },
      async (input) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ files: [], total: 0, filters: input }),
          },
        ],
      }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await mcp.connect(transport);
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({
        method: body ? JSON.parse(body).method : req.method,
        version: req.headers['x-hyper3d-cli-version'],
      });
      await transport.handleRequest(
        req,
        res,
        body ? JSON.parse(body) : undefined,
      );
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    } finally {
      await transport.close();
      await mcp.close();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  const run = async (args) => {
    try {
      return {
        ...(await exec(
          process.execPath,
          [executable, '--base-url', endpoint.replace(/\/mcp$/, ''), ...args],
          {
            env: {
              ...process.env,
              HYPER3D_CONFIG_DIR: config,
              CI: '1',
            },
            timeout: 15000,
          },
        )),
        code: 0,
      };
    } catch (error) {
      return { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
  };
  try {
    const help = await run(['--help']);
    assert.equal(help.code, 0, help.stderr);
    assert.doesNotMatch(help.stdout, /^\s+(tools|schema)(?:\s|$)/m);
    assert.match(help.stdout, /--output <format>/);
    assert.doesNotMatch(help.stdout, /--schema-version/);
    for (const command of [
      'agentic',
      'rigging',
      'animation-presets',
      'polygen',
    ]) {
      assert.match(help.stdout, new RegExp(command));
      assert.equal((await run([command, '--help'])).code, 0);
    }
    const listed = await run([
      'list_upload',
      '--kind',
      'model',
      '--page',
      '2',
      '--output',
      'json',
    ]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout), {
      files: [],
      total: 0,
      filters: { kind: 'model', page: 2 },
    });
    const defaultList = await run(['list_upload', '--output', 'json']);
    assert.equal(defaultList.code, 0, defaultList.stderr);
    assert.deepEqual(JSON.parse(defaultList.stdout).filters, { page: 1 });
    const assetId = 'd1bb98f2-48be-4be1-9818-d49de002497a';
    const plainPolygen = await run(['polygen', assetId, '--output', 'json']);
    assert.equal(plainPolygen.code, 0, plainPolygen.stderr);
    assert.deepEqual(JSON.parse(plainPolygen.stdout), { asset_id: assetId });
    const explicitPolygen = await run([
      'polygen',
      assetId,
      '--face-count',
      '2000',
      '--no-quad-normal',
      '--hd-texture',
      '--output',
      'json',
    ]);
    assert.equal(explicitPolygen.code, 0, explicitPolygen.stderr);
    assert.deepEqual(JSON.parse(explicitPolygen.stdout), {
      asset_id: assetId,
      face_count: 2000,
      quad_normal: false,
      hd_texture: true,
    });
    assert.equal(
      (await run(['polygen', assetId, '--face-count', '199'])).code,
      1,
    );
    const rigged = await run([
      'rigging',
      'd1bb98f2-48be-4be1-9818-d49de002497a',
      '--bone-template',
      'human',
      '--animation-preset',
      'human/ArmStretching',
      '--output',
      'json',
    ]);
    assert.equal(rigged.code, 0, rigged.stderr);
    assert.equal(JSON.parse(rigged.stdout).bone_template, 'human');
    assert.deepEqual(JSON.parse(rigged.stdout).animation_preset, [
      'human/ArmStretching',
    ]);
    const presets = await run([
      'animation-presets',
      '--category',
      'human',
      '--output',
      'json',
    ]);
    assert.equal(presets.code, 0, presets.stderr);
    assert.equal(JSON.parse(presets.stdout).category, 'human');
    for (const category of [undefined, 'human', 'human_sp', 'unknown']) {
      const args = ['animation-catalog', '--output', 'json'];
      if (category) args.push('--category', category);
      const response = await run(args);
      assert.equal(response.code, 0, response.stderr);
      assert.equal(response.stderr, '');
      assert.deepEqual(JSON.parse(response.stdout), {
        categories:
          category === 'unknown'
            ? []
            : [{ category: 'human', animations: [animation] }],
      });
    }
    assert.deepEqual(catalogInputs, [
      {},
      { category: 'human' },
      { category: 'human_sp' },
      { category: 'unknown' },
    ]);
    const humanCatalog = await run([
      'animation-catalog',

      '--category',
      'human',
    ]);
    assert.equal(humanCatalog.code, 0, humanCatalog.stderr);
    assert.match(humanCatalog.stdout, /Walking/);
    assert.match(humanCatalog.stdout, /human_000093/);
    const selected = await run([
      'rigging',
      'd1bb98f2-48be-4be1-9818-d49de002497a',
      '--bone-template',
      'human',
      '--animation-preset',
      animation.animation_id,
      '--output',
      'json',
    ]);
    assert.equal(selected.code, 0, selected.stderr);
    assert.deepEqual(JSON.parse(selected.stdout).animation_preset, [
      animation.animation_id,
    ]);
    const legacy = await run([
      'animation-presets',
      '--category',
      'human',
      '--output',
      'json',
    ]);
    assert.equal(legacy.code, 0, legacy.stderr);
    assert.deepEqual(JSON.parse(legacy.stdout), { category: 'human' });
    catalogAvailable = false;
    const unavailable = await run(['animation-catalog']);
    assert.equal(unavailable.code, 1);
    assert.match(
      unavailable.stderr,
      /Tool unavailable: rodin_list_animation_catalog/,
    );
    assert.equal(catalogInputs.length, 5);
    const missingTemplate = await run([
      'rigging',
      'd1bb98f2-48be-4be1-9818-d49de002497a',
    ]);
    assert.equal(missingTemplate.code, 1);
    assert.match(missingTemplate.stderr, /required option/);
    const agenticHelp = await run(['agentic', '--help']);
    assert.match(agenticHelp.stdout, /procedural n-gons-friendly geometry/);
    assert.match(agenticHelp.stdout, /beta/);
    const invalidAgentic = await run(['agentic', '--output', 'json']);
    assert.equal(invalidAgentic.code, 1);
    assert.equal(invalidAgentic.stdout, '');
    assert.match(invalidAgentic.stderr, /Agentic is beta/);
    assert.match(invalidAgentic.stderr, /one to five/);
    const generated = await run([
      'generate',
      '--prompt',
      'a cat',
      '--tier',
      'Future',
    ]);
    assert.equal(generated.code, 0, generated.stderr);
    assert.match(generated.stdout, /^Generation ID: test-generation$/m);
    assert.match(generated.stdout, /^Prompt: a cat$/m);
    assert.match(generated.stderr, /accepted by the server/);
    assert.equal(generated.stderr.match(/accepted by the server/g)?.length, 1);
    const generatedJson = await run([
      'generate',
      '--prompt',
      'a cat',
      '--tier',
      'Future',
      '--output',
      'json',
    ]);
    assert.equal(generatedJson.code, 0, generatedJson.stderr);
    assert.equal(JSON.parse(generatedJson.stdout).prompt, 'a cat');
    const invalidOutput = await run([
      'generate',
      '--prompt',
      'a cat',
      '--output',
      'yaml',
    ]);
    assert.equal(invalidOutput.code, 1);
    assert.match(invalidOutput.stderr, /Allowed choices are human, json/);
    const unsupported = await run([
      '--schema-version',
      'v1',
      'generate',
      '--prompt',
      'a cat',
    ]);
    assert.equal(unsupported.code, 1);
    assert.match(unsupported.stderr, /unknown option '--schema-version'/);
    const failed = await run([
      'poll',
      'd1bb98f2-48be-4be1-9818-d49de002497a',
      '--timeout',
      '90',
    ]);
    assert.equal(failed.code, 1, failed.stderr);
    assert.match(failed.stderr, /test failure/);
    assert.equal(calls, 1);
    for (const method of [
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
    ])
      assert.ok(
        requests.some((request) => request.method === method),
        method,
      );
    for (const request of requests)
      assert.equal(request.version, version, request.method);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(config, { recursive: true, force: true });
  }
});
