import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getContract,
  prepareCall,
} from '../packages/cli/dist/contracts/index.js';
import {
  createOperations,
  resultData,
} from '../packages/cli/dist/operations.js';

const contract = getContract();
const id = 'd1bb98f2-48be-4be1-9818-d49de002497a';

test('CLI results omit top-level display_url and preserve other URLs', () => {
  const response = {
    display_url: 'https://display.example',
    files: [{ url: 'https://file.example' }],
  };
  assert.deepEqual(resultData({ structuredContent: response }), {
    files: response.files,
  });
  assert.deepEqual(
    resultData({ content: [{ type: 'text', text: JSON.stringify(response) }] }),
    { files: response.files },
  );
});

test('actual remote enum governs acceptance, local differences only warn', () => {
  const remote = structuredClone(
    contract.schema.tools.find((t) => t.name === 'rodin_generate'),
  );
  remote.inputSchema.properties.tier.enum.push('Future');
  const warnings = [];
  assert.equal(
    prepareCall(
      contract,
      remote.name,
      { prompt: 'cat', tier: 'Future' },
      remote,
      (m) => warnings.push(m),
    ).arguments.tier,
    'Future',
  );
  assert.equal(warnings.length, 1);
  remote.inputSchema.properties.tier.enum = ['Future'];
  assert.throws(
    () =>
      prepareCall(contract, remote.name, { tier: 'Gen-2.5-Medium' }, remote),
    /Invalid tool input/,
  );
  assert.throws(() => getContract('v99'), /Unsupported schema version/);
});

test('generate uploads ordered images, then generates once; failures never generate', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hyper3d-operation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = [join(dir, 'a.png'), join(dir, 'b.png')];
  await Promise.all(paths.map((p, i) => writeFile(p, Buffer.from([i + 1]))));
  const events = [];
  let failUpload = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    events.push({ url, options });
    return new Response('', { status: failUpload ? 500 : 200 });
  });
  const client = {
    async callTool(request) {
      events.push(request);
      if (request.name === 'rodin_create_uploads')
        return {
          structuredContent: {
            uploads: paths.map((_, i) => ({
              upload_id: i ? 'a1bb98f2-48be-4be1-9818-d49de002497a' : id,
              upload_url: `https://upload.example/${i}`,
              method: 'PUT',
              headers: { 'Content-Type': 'image/png' },
            })),
          },
        };
      return {
        structuredContent: { generation_id: id, status: 'future-status' },
      };
    },
  };
  const ops = createOperations(client, contract, contract.schema.tools);
  assert.equal((await ops.generate({ image: paths })).status, 'future-status');
  assert.deepEqual(
    events.map((e) => e.name ?? e.url),
    [
      'rodin_create_uploads',
      'https://upload.example/0',
      'https://upload.example/1',
      'rodin_generate',
    ],
  );
  assert.equal(events[0].arguments.files[0].filename, 'a.png');
  assert.deepEqual([...events[1].options.body], [1]);
  assert.equal(events[1].options.headers.Authorization, undefined);
  assert.deepEqual(events[3].arguments.reference_upload_ids, [
    id,
    'a1bb98f2-48be-4be1-9818-d49de002497a',
  ]);
  events.length = 0;
  failUpload = true;
  await assert.rejects(
    ops.generate({ image: paths }),
    /generation was not started/,
  );
  assert.equal(
    events.some((e) => e.name === 'rodin_generate'),
    false,
  );
  events.length = 0;
  await assert.rejects(
    ops.generate({ image: paths, tier: 'invalid' }),
    /Invalid tool input/,
  );
  assert.equal(events.length, 0);
  await assert.rejects(ops.generate({}), /Provide --prompt or --image/);
  await assert.rejects(
    ops.generate({ image: [...paths, ...paths, ...paths] }),
    /at most five/,
  );
});

test('text generation preserves server errors and never retries', async () => {
  let calls = 0;
  const ops = createOperations(
    {
      async callTool() {
        calls++;
        return {
          isError: true,
          content: [{ type: 'text', text: 'no credits' }],
        };
      },
    },
    contract,
    contract.schema.tools,
  );
  await assert.rejects(ops.generate({ prompt: 'cat' }), /no credits/);
  assert.equal(calls, 1);
});

test('poll continues bounded wait calls until terminal state or total timeout', async () => {
  const requests = [];
  const responses = [
    {
      generation_id: id,
      status: 'processing',
      stage: { name: 'Geometry', current: 1, total: 2 },
      timed_out: true,
    },
    {
      generation_id: id,
      status: 'processing',
      stage: { name: 'Geometry', current: 1, total: 2 },
      timed_out: true,
    },
    {
      generation_id: id,
      status: 'completed',
      stage: { name: 'Pack', current: 2, total: 2 },
      timed_out: false,
    },
  ];
  const client = {
    async callTool(request) {
      requests.push(request);
      return { structuredContent: responses.shift() };
    },
  };
  const ops = createOperations(client, contract, contract.schema.tools);
  const result = await ops.poll(id, 100);
  assert.equal(result.status, 'completed');
  assert.deepEqual(
    requests.map((request) => request.arguments.timeout_seconds),
    [30, 30, 30],
  );

  requests.length = 0;
  responses.push(
    {
      generation_id: id,
      status: 'queued',
      stage: { name: 'Queued', current: 0, total: 2 },
      timed_out: true,
    },
    {
      generation_id: id,
      status: 'processing',
      stage: { name: 'Geometry', current: 1, total: 2 },
      timed_out: true,
    },
  );
  const timedOut = await ops.poll(id, 46);
  assert.equal(timedOut.timed_out, true);
  assert.deepEqual(
    requests.map((request) => request.arguments.timeout_seconds),
    [30, 16],
  );

  requests.length = 0;
  responses.push({
    generation_id: id,
    status: 'completed',
    stage: { name: 'Pack', current: 2, total: 2 },
    timed_out: false,
  });
  await ops.poll(id);
  assert.deepEqual(
    requests.map((request) => request.arguments.timeout_seconds),
    [30],
  );
  await assert.rejects(ops.poll(id, 0), /positive integer/);
  await assert.rejects(ops.poll(id, 1.5), /positive integer/);
});
