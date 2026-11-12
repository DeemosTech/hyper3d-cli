import test from 'node:test';
import assert from 'node:assert/strict';
import { polygen } from '../packages/cli/dist/operations.js';
import { baseSchema } from '../packages/cli/dist/schema.js';
const id = 'd1bb98f2-48be-4be1-9818-d49de002497a';
function harness(remoteTools = baseSchema.tools) {
  const calls = [];
  return {
    calls,
    context: {
      remoteTools,
      client: {
        async callTool(request) {
          calls.push(request);
          return { structuredContent: { generation_id: id, status: 'queued' } };
        },
      },
    },
  };
}
test('polygen omits defaults and maps explicit texture and geometry controls', async () => {
  const { calls, context } = harness();
  await polygen(id, {}, context);
  assert.deepEqual(calls[0], {
    name: 'rodin_generate_polygen',
    arguments: { asset_id: id },
  });
  await polygen(
    id,
    {
      quality: 'auto',
      faceCount: 2000,
      meshMode: 'Quad',
      format: 'obj',
      quadNormal: false,
      material: 'PBR',
      referenceScale: 0,
      escore: 0,
      hdTexture: false,
    },
    context,
  );
  assert.deepEqual(calls[1].arguments, {
    asset_id: id,
    quality: 'auto',
    face_count: 2000,
    mesh_mode: 'Quad',
    geometry_file_format: 'obj',
    quad_normal: false,
    material: 'PBR',
    reference_scale: 0,
    escore: 0,
    hd_texture: false,
  });
});
test('polygen validates against live schema before submitting and fails on older servers', async () => {
  const { calls, context } = harness();
  for (const faceCount of [199, 20001, 200.5, NaN])
    await assert.rejects(
      polygen(id, { faceCount }, context),
      /Invalid tool input/,
    );
  assert.equal(calls.length, 0);
  await assert.rejects(
    polygen(id, {}, harness([]).context),
    /Tool unavailable/,
  );
});
test('polygen never retries a failed submission', async () => {
  let calls = 0;
  const context = {
    remoteTools: baseSchema.tools,
    client: {
      async callTool() {
        calls++;
        throw new Error('timed out');
      },
    },
  };
  await assert.rejects(polygen(id, {}, context), /timed out/);
  assert.equal(calls, 1);
});
