import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, copyFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  baseSchema,
  canarySchema,
  prepareCall,
} from '../packages/cli/dist/schema.js';
import {
  generate,
  agentic,
  rigging,
  listUploads,
} from '../packages/cli/dist/operations.js';

const fileId = 'AbCdEfGhIjKlMnOpQrStUA';
const generationId = 'd1bb98f2-48be-4be1-9818-d49de002497a';

test('canary uploads use new IDs, omit MIME and accept empty headers across workflows', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hyper3d-canary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const image = join(dir, 'cat.png');
  const model = join(dir, 'cat.glb');
  const animation = join(dir, 'walk.fbx');
  await Promise.all(
    [image, model, animation].map((path) => writeFile(path, 'bytes')),
  );
  const events = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    events.push({ put: options });
    return new Response('', { status: 200 });
  });
  const context = {
    schemaVersion: 'canary',
    remoteTools: canarySchema.tools,
    client: {
      async callTool(request) {
        events.push(request);
        return {
          structuredContent:
            request.name === 'rodin_create_uploads'
              ? {
                  uploads: [
                    {
                      upload_id: fileId,
                      upload_url: 'https://upload.example/file',
                      method: 'PUT',
                      headers: {},
                    },
                  ],
                }
              : { generation_id: generationId, status: 'queued' },
        };
      },
    },
  };
  for (const run of [
    () => generate({ image: [image] }, context),
    () => agentic({ image: [image] }, context),
    () =>
      rigging(
        generationId,
        { boneTemplate: 'human', animation: [animation] },
        context,
      ),
    () => rigging(undefined, { boneTemplate: 'human', model }, context),
  ]) {
    events.length = 0;
    assert.equal((await run()).status, 'queued');
    assert.equal(events.length, 3);
    assert.equal(events[0].name, 'rodin_create_uploads');
    assert.equal('mime_type' in events[0].arguments.files[0], false);
    assert.deepEqual(events[1].put.headers, {});
    assert.ok(JSON.stringify(events[2].arguments).includes(fileId));
  }
  assert.equal(events[0].arguments.kind, 'model');
  assert.equal(events[2].arguments.model_upload_id, fileId);
});

test('selected contract does not follow remote schema automatically', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hyper3d-default-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const image = join(dir, 'cat.png');
  await writeFile(image, 'bytes');
  let calls = 0;
  const context = {
    remoteTools: canarySchema.tools,
    client: {
      async callTool() {
        calls++;
      },
    },
  };
  await assert.rejects(
    generate({ image: [image] }, context),
    /Invalid tool input/,
  );
  await assert.rejects(listUploads({}, context), /requires? --canary-schema/);
  await assert.rejects(
    rigging(undefined, { boneTemplate: 'human', model: image }, context),
    /requires? --canary-schema/,
  );
  assert.equal(calls, 0);
  const tool = canarySchema.tools.find(
    (tool) => tool.name === 'rodin_list_uploads',
  );
  assert.throws(() => prepareCall(tool.name, {}, tool), /Unsupported tool/);
  assert.doesNotThrow(() =>
    prepareCall(tool.name, {}, tool, undefined, 'canary'),
  );
});

test('list_upload maps filters and preserves the backend file response', async () => {
  const payload = {
    files: [
      {
        upload_id: fileId,
        kind: 'model',
        format: 'glb',
        name: 'chair',
        tags: [],
        created_at: '2026-11-03T10:00:00.000Z',
      },
    ],
    total: 51,
  };
  let request;
  const context = {
    schemaVersion: 'canary',
    remoteTools: canarySchema.tools,
    client: {
      async callTool(value) {
        request = value;
        return { structuredContent: payload };
      },
    },
  };
  assert.deepEqual(
    await listUploads({ kind: 'model', tag: 'prop', page: 2 }, context),
    payload,
  );
  assert.deepEqual(request, {
    name: 'rodin_list_uploads',
    arguments: { kind: 'model', tag: 'prop', page: 2 },
  });
  await assert.rejects(listUploads({ page: 0 }, context), /Invalid tool input/);
  await assert.rejects(
    listUploads({}, { ...context, remoteTools: baseSchema.tools }),
    /Tool unavailable/,
  );
});

test('global canary switch is discoverable and list_upload is gated before connecting', () => {
  const command = ['packages/cli/dist/index.js'];
  const help = spawnSync(
    process.execPath,
    [...command, '--canary-schema', 'list_upload', '--help'],
    { encoding: 'utf8' },
  );
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--kind/);
  const rejected = spawnSync(process.execPath, [...command, 'list_upload'], {
    encoding: 'utf8',
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /requires? --canary-schema/);
});

test('default schema loads without the optional canary snapshot', async (t) => {
  const dir = await mkdtemp(join(resolve('packages/cli'), 'schema-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await Promise.all(
    ['schema.js', 'base_schema.json'].map((name) =>
      copyFile(join('packages/cli/dist', name), join(dir, name)),
    ),
  );
  const script = `import { schemaFor } from ${JSON.stringify(pathToFileURL(join(dir, 'schema.js')).href)};
    if (!schemaFor().tools.length) process.exit(2);
    try { schemaFor('canary'); process.exit(3); } catch (error) {
      if (!error.message.includes('does not include a canary schema')) throw error;
    }`;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('canary accepts images over 20 MiB while default stops before allocation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hyper3d-size-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const image = join(dir, 'large.png');
  await writeFile(image, '');
  await truncate(image, 21 * 1024 ** 2);
  let calls = 0;
  const client = {
    async callTool() {
      calls++;
      throw new Error('allocation reached');
    },
  };
  await assert.rejects(
    generate({ image: [image] }, { client, remoteTools: baseSchema.tools }),
    /size limit/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    generate(
      { image: [image] },
      { client, remoteTools: canarySchema.tools, schemaVersion: 'canary' },
    ),
    /allocation reached/,
  );
  assert.equal(calls, 1);
});
