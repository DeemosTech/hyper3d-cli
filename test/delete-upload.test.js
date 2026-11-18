import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteUploads } from '../packages/cli/dist/operations.js';
import {
  baseSchema,
  canarySchema,
  useCanarySchema,
} from '../packages/cli/dist/schema.js';

test('canary deletion validates remotely, calls once and preserves removed IDs', async () => {
  const id = 'AbCdEfGhIjKlMnOpQrStUA';
  const calls = [];
  const context = {
    remoteTools: canarySchema.tools,
    client: {
      callTool: async (request) => {
        calls.push(request);
        return { structuredContent: { deleted_upload_ids: [id] }, content: [] };
      },
    },
  };
  assert.ok(
    !baseSchema.tools.some((tool) => tool.name === 'rodin_delete_uploads'),
  );
  await assert.rejects(deleteUploads([id], context), /Unsupported tool/);
  useCanarySchema(true);
  try {
    assert.deepEqual(await deleteUploads([id], context), {
      deleted_upload_ids: [id],
    });
    assert.deepEqual(calls, [
      { name: 'rodin_delete_uploads', arguments: { upload_ids: [id] } },
    ]);
    await assert.rejects(deleteUploads([], context), /Invalid tool input/);
    await assert.rejects(
      deleteUploads([id], { ...context, remoteTools: baseSchema.tools }),
      /Tool unavailable/,
    );
    assert.equal(calls.length, 1);
  } finally {
    useCanarySchema(false);
  }
});
