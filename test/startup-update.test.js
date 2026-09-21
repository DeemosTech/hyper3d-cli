import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startupUpdate, updateChannel } from '../packages/cli/dist/update.js';

const pkg = { name: '@hyper3d/cli', version: '0.1.0' };
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'hyper3d-startup-'));
  const directory = join(root, pkg.name);
  await mkdir(directory, { recursive: true });
  const calls = [],
    output = [];
  const options = {
    interactive: true,
    env: { HYPER3D_CONFIG_DIR: join(root, 'config') },
    run: async (args) => {
      calls.push(args);
      return args[0] === 'root' ? root : args[0] === 'view' ? '"0.2.0"' : '';
    },
    write: (text) => output.push(text),
  };
  try {
    await run({ root, directory, calls, output, options });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('interactive npm global install auto-updates exact version, requests rerun, and checks once a day', () =>
  fixture(async ({ directory, calls, output, options }) => {
    assert.equal(await startupUpdate(pkg, directory, options), true);
    assert.deepEqual(calls.at(-1), [
      'install',
      '--global',
      '@hyper3d/cli@0.2.0',
      '--no-fund',
      '--no-audit',
    ]);
    assert.match(output.join(''), /has not been executed/);
    assert.equal(await startupUpdate(pkg, directory, options), false);
    assert.equal(calls.filter((args) => args[0] === 'view').length, 1);
  }));
test('CI, noninteractive, disabled and private builds do not even invoke npm', () =>
  fixture(async ({ directory, calls, options }) => {
    for (const override of [
      { interactive: false },
      { env: { CI: 'true' } },
      { env: { HYPER3D_UPDATE_CHECK: '0' } },
    ])
      assert.equal(
        await startupUpdate(pkg, directory, { ...options, ...override }),
        false,
      );
    assert.equal(
      await startupUpdate({ ...pkg, private: true }, directory, options),
      false,
    );
    assert.deepEqual(calls, []);
  }));
test('local installs are untouched, opt-out only notifies, and a lock avoids concurrent updates', () =>
  fixture(async ({ root, directory, calls, output, options }) => {
    assert.equal(await startupUpdate(pkg, root, options), false);
    assert.deepEqual(
      calls.map((args) => args[0]),
      ['root'],
    );
    await startupUpdate(pkg, directory, {
      ...options,
      env: { ...options.env, HYPER3D_AUTO_UPDATE: '0' },
    });
    assert.match(output.join(''), /Update available/);
    assert.equal(
      calls.some((args) => args[0] === 'install'),
      false,
    );
    await mkdir(join(options.env.HYPER3D_CONFIG_DIR, 'update.lock'));
    assert.equal(
      await startupUpdate({ ...pkg, version: '0.1.1' }, directory, options),
      false,
    );
    assert.equal(calls.filter((args) => args[0] === 'view').length, 1);
  }));
test('registry failures warn, allow operation, and are throttled', () =>
  fixture(async ({ directory, calls, output, options }) => {
    const original = options.run;
    options.run = async (args) => {
      const value = await original(args);
      if (args[0] === 'view') throw new Error('offline');
      return value;
    };
    assert.equal(await startupUpdate(pkg, directory, options), false);
    assert.match(output.join(''), /failed/);
    assert.equal(await startupUpdate(pkg, directory, options), false);
    assert.equal(calls.filter((args) => args[0] === 'view').length, 1);
  }));
test('prerelease installs follow their own channel', () => {
  assert.equal(updateChannel(pkg), 'latest');
  assert.equal(updateChannel({ ...pkg, version: '0.2.0-next.17' }), 'next');
  assert.equal(updateChannel({ ...pkg, version: '0.2.0-beta.1' }), 'beta');
});

test('npm-linked source checkouts never self-update', () =>
  fixture(async ({ root, directory, calls, options }) => {
    const source = join(root, 'source');
    await mkdir(source);
    await rm(directory, { recursive: true });
    await symlink(
      source,
      directory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.equal(await startupUpdate(pkg, source, options), false);
    assert.deepEqual(
      calls.map((args) => args[0]),
      ['root'],
    );
  }));
