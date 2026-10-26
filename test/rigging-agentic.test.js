import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentic,
  rigging,
  animationPresets,
  poll,
} from '../packages/cli/dist/operations.js';
import { baseSchema } from '../packages/cli/dist/schema.js';
const id = 'd1bb98f2-48be-4be1-9818-d49de002497a';

for (const mode of ['agentic', 'rigging']) {
  test(`${mode}: ordered uploads, validation before upload and no submission retries`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'hyper3d-new-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const paths = [
      join(dir, mode === 'agentic' ? 'a.png' : 'a.fbx'),
      join(dir, mode === 'agentic' ? 'b.png' : 'b.fbx'),
    ];
    await Promise.all(paths.map((p) => writeFile(p, 'fixture')));
    const events = [];
    let uploadStatus = 200;
    let submitError = false;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      events.push({ url, options });
      return new Response('', { status: uploadStatus });
    });
    const ids = [id, 'a1bb98f2-48be-4be1-9818-d49de002497a'];
    const context = {
      remoteTools: baseSchema.tools,
      client: {
        async callTool(request) {
          events.push(request);
          if (request.name === 'rodin_create_uploads')
            return {
              structuredContent: {
                uploads: ids.map((upload_id, i) => ({
                  upload_id,
                  upload_url: `https://uploads.example/${i}`,
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/octet-stream' },
                })),
              },
            };
          if (submitError) throw new Error('submission timed out');
          return {
            structuredContent: { generation_id: id, producer: 'n-gons' },
          };
        },
      },
    };
    const run = (extra = {}) =>
      mode === 'agentic'
        ? agentic(
            { image: paths, tier: 'basic', format: 'stl', ...extra },
            context,
          )
        : rigging(
            id,
            {
              boneTemplate: 'human',
              animation: paths,
              format: 'fbx',
              ...extra,
            },
            context,
          );
    assert.equal((await run()).generation_id, id);
    assert.deepEqual(
      events.map((e) => e.name ?? e.url),
      [
        'rodin_create_uploads',
        'https://uploads.example/0',
        'https://uploads.example/1',
        `rodin_generate_${mode}`,
      ],
    );
    assert.equal(
      events[0].arguments.kind,
      mode === 'agentic' ? undefined : 'animation',
    );
    assert.deepEqual(
      events[3].arguments[
        mode === 'agentic' ? 'reference_upload_ids' : 'animation_upload_ids'
      ],
      ids,
    );
    assert.equal(
      events[3].arguments[
        mode === 'agentic' ? 'export_type' : 'geometry_file_format'
      ],
      mode === 'agentic' ? 'stl' : 'fbx',
    );
    assert.equal(events[1].options.headers.Authorization, undefined);
    assert.equal(events[1].options.redirect, 'error');
    events.length = 0;
    await assert.rejects(run({ format: 'obj' }), /Invalid tool input/);
    assert.equal(events.length, 0);
    uploadStatus = 500;
    await assert.rejects(run(), /generation was not started/);
    assert.equal(
      events.some((e) => e.name === `rodin_generate_${mode}`),
      false,
    );
    uploadStatus = 200;
    events.length = 0;
    submitError = true;
    await assert.rejects(run(), /operation was not retried/);
    assert.equal(
      events.filter((e) => e.name === `rodin_generate_${mode}`).length,
      1,
    );
    events.length = 0;
    context.remoteTools = baseSchema.tools.filter(
      (t) => t.name !== `rodin_generate_${mode}`,
    );
    await assert.rejects(run(), /Tool unavailable/);
    assert.equal(events.length, 0);
  });
}

test('rigging validates combinations and supports presets or skeleton only', async () => {
  const calls = [];
  const context = {
    remoteTools: baseSchema.tools,
    client: {
      async callTool(request) {
        calls.push(request);
        return { structuredContent: { generation_id: id } };
      },
    },
  };
  for (const options of [
    { boneTemplate: 'custom' },
    { boneTemplate: 'human', skeletonDescription: 'body' },
    { boneTemplate: 'human', animation: ['a.fbx'], animationPreset: ['x'] },
    { boneTemplate: 'human', animationPreset: ['x', 'x'] },
    { boneTemplate: 'human', animation: Array(11).fill('a.fbx') },
  ])
    await assert.rejects(rigging(id, options, context));
  await assert.rejects(agentic({}, context), /one to five/);
  assert.equal(calls.length, 0);
  await rigging(
    id,
    { boneTemplate: 'custom', skeletonDescription: 'four arms' },
    context,
  );
  await rigging(
    id,
    { boneTemplate: 'human', animationPreset: ['human/ArmStretching'] },
    context,
  );
  assert.equal(calls[0].arguments.skeleton_description, 'four arms');
  assert.deepEqual(calls[1].arguments.animation_preset, [
    'human/ArmStretching',
  ]);
  assert.equal(calls[0].arguments.animation_upload_ids, undefined);
});

test('preset discovery passes category; unknown stops polling even with timed_out', async () => {
  const calls = [];
  const context = {
    remoteTools: baseSchema.tools,
    client: {
      async callTool(request) {
        calls.push(request);
        return { structuredContent: { status: 'unknown', timed_out: true } };
      },
    },
  };
  await animationPresets(undefined, context);
  const category = baseSchema.tools.find(
    (t) => t.name === 'rodin_list_animation_presets',
  ).inputSchema.properties.category.enum[0];
  await animationPresets(category, context);
  assert.deepEqual(calls[0].arguments, {});
  assert.deepEqual(calls[1].arguments, { category });
  assert.equal((await poll(id, 100, context)).status, 'unknown');
  assert.equal(calls.length, 3);
});
