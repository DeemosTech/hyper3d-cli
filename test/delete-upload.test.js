import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteUploads } from '../packages/cli/dist/operations.js';
import { baseSchema } from '../packages/cli/dist/schema.js';

test('default deletion validates remotely, calls once and preserves removed IDs', async () => {
  const id = 'AbCdEfGhIjKlMnOpQrStUA';
  const calls = [];
  const context = {
    remoteTools: baseSchema.tools,
    client: {
      callTool: async (request) => {
        calls.push(request);
        return { structuredContent: { deleted_upload_ids: [id] }, content: [] };
      },
    },
  };
  assert.deepEqual(await deleteUploads([id], context), {
    deleted_upload_ids: [id],
  });
  assert.deepEqual(calls, [
    { name: 'rodin_delete_uploads', arguments: { upload_ids: [id] } },
  ]);
  await assert.rejects(deleteUploads([], context), /Invalid tool input/);
  await assert.rejects(
    deleteUploads([id], {
      ...context,
      remoteTools: baseSchema.tools.filter(
        (tool) => tool.name !== 'rodin_delete_uploads',
      ),
    }),
    /Tool unavailable/,
  );
  assert.equal(calls.length, 1);
});
