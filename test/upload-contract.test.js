import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { baseSchema } from '../packages/cli/dist/schema.js';
import {
  generate,
  agentic,
  rigging,
  listUploads,
} from '../packages/cli/dist/operations.js';

const fileId = 'AbCdEfGhIjKlMnOpQrStUA';
const generationId = 'd1bb98f2-48be-4be1-9818-d49de002497a';

test('default uploads use new IDs, omit MIME and accept empty headers across workflows', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hyper3d-upload-'));
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
    remoteTools: baseSchema.tools,
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
    remoteTools: baseSchema.tools,
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
    listUploads(
      {},
      {
        ...context,
        remoteTools: baseSchema.tools.filter(
          (tool) => tool.name !== 'rodin_list_uploads',
        ),
      },
    ),
    /Tool unavailable/,
  );
});

test('canary switch always reports no active schema without connecting', () => {
  for (const args of [
    ['--canary-schema'],
    ['--canary-schema', 'generate'],
    ['rigging', '--canary-schema'],
    ['--base-url', 'invalid', '--canary-schema', 'list_upload'],
    ['--canary-schema', '--help'],
    ['--version', '--canary-schema'],
    ['unknown', '--canary-schema', '--unknown-option'],
  ]) {
    const result = spawnSync(
      process.execPath,
      ['packages/cli/dist/index.js', ...args],
      {
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'No canary schema is in progress\n');
    assert.equal(result.stderr, '');
  }
});

test('default accepts images up to 25 MiB and rejects larger files before allocation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hyper3d-size-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const image = join(dir, 'large.png');
  await writeFile(image, '');
  await truncate(image, 25 * 1024 ** 2);
  let calls = 0;
  const client = {
    async callTool() {
      calls++;
      throw new Error('allocation reached');
    },
  };
  await assert.rejects(
    generate({ image: [image] }, { client, remoteTools: baseSchema.tools }),
    /allocation reached/,
  );
  assert.equal(calls, 1);
  await truncate(image, 25 * 1024 ** 2 + 1);
  await assert.rejects(
    generate({ image: [image] }, { client, remoteTools: baseSchema.tools }),
    /size limit/,
  );
  assert.equal(calls, 1);
});
