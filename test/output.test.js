import test from 'node:test';
import assert from 'node:assert/strict';
import { formatOutput } from '../packages/cli/dist/output.js';

test('human output formats generation status and nested file data in English', () => {
  assert.equal(
    formatOutput({
      generation_id: 'generation-1',
      status: 'processing',
      stage: { name: 'Geometry', current: 1, total: 2 },
      timed_out: false,
    }),
    [
      'Generation ID: generation-1',
      'Status: processing',
      'Stage: Geometry (1/2)',
      'Timed out: No',
    ].join('\n'),
  );
  assert.equal(
    formatOutput({
      files: [
        {
          name: 'model.glb',
          role: 'model',
          mime_type: 'model/gltf-binary',
          url: 'https://example.com/model.glb',
        },
      ],
    }),
    [
      'Files:',
      '  - Name: model.glb',
      '    Role: model',
      '    MIME type: model/gltf-binary',
      '    URL: https://example.com/model.glb',
    ].join('\n'),
  );
});

test('human output provides concise authentication and account messages', () => {
  assert.equal(
    formatOutput({ authenticated: true }, { kind: 'auth-login' }),
    'Authenticated successfully.',
  );
  assert.equal(
    formatOutput({ localCredentialsRemoved: true }, { kind: 'auth-logout' }),
    'Local credentials removed.',
  );
  assert.equal(
    formatOutput({ authenticated: false }, { kind: 'account' }),
    'Not authenticated. Run hyper3d auth login.',
  );
  assert.equal(
    formatOutput(
      {
        authenticated: true,
        user: { uuid: 'user-1', username: 'fixture' },
        wallet: {
          type: 'personal',
          balance: 12.5,
          subscription_balance: 10,
          frozen: 0.5,
        },
      },
      { kind: 'account' },
    ),
    [
      'Authenticated as fixture',
      'User ID: user-1',
      'Workspace: Personal',
      'Credits:',
      '  Regular: 12.5',
      '  Subscription: 10',
      '  Frozen: 0.5',
    ].join('\n'),
  );
});

test('JSON output preserves the original value', () => {
  const value = {
    generation_id: 'generation-1',
    status: 'queued',
    extra: { future: true },
  };
  assert.deepEqual(JSON.parse(formatOutput(value, { format: 'json' })), value);
});
