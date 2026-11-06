import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createAssetManager, AssetError } from '../dist/esm/index.js';

const input = (id = 'logo') => ({
  id,
  name: 'Logo',
  mediaType: 'image/svg+xml',
  bytes: 10,
  url: 'https://example.org/logo.svg',
  tags: ['brand'],
  license: { identifier: 'CC-BY-4.0', attribution: 'Artist', url: 'https://example.org/license' },
  description: 'Brand logo',
});
const upload = (id = 'logo') => {
  const { url, bytes, ...metadata } = input(id);
  return { ...metadata, data: new Uint8Array([1, 2, 3]) };
};
const code = (expected) => (error) => error instanceof AssetError && error.code === expected;
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('metadata is detached, frozen, searchable and revision guarded', () => {
  const manager = createAssetManager();
  const source = input();
  const asset = manager.add(source);
  source.tags.push('changed');
  source.license.identifier = 'changed';
  assert.deepEqual(asset.tags, ['brand']);
  assert.equal(asset.license.identifier, 'CC-BY-4.0');
  assert.throws(() => {
    asset.tags.push('x');
  }, TypeError);
  assert.equal(manager.list('brand').length, 1);
  assert.equal(manager.list('missing').length, 0);
  assert.equal(manager.get('missing'), undefined);
  assert.equal(manager.size, 1);
  const changed = manager.update('logo', 1, { name: 'New', license: { identifier: 'MIT' } });
  assert.equal(changed.revision, 2);
  assert.equal(changed.description, undefined);
  assert.deepEqual(changed.tags, []);
  assert.throws(
    () => manager.update('logo', 1, { name: 'Old', license: { identifier: 'MIT' } }),
    code('conflict'),
  );
  assert.throws(() => manager.remove('logo', 1), code('conflict'));
  assert.equal(manager.remove('logo', 2), true);
  assert.equal(manager.size, 0);
});

test('invalid assets never mutate the store', () => {
  const manager = createAssetManager({ maxBytes: 20 });
  for (const patch of [
    { id: '' },
    { name: '' },
    { mediaType: 'IMAGE/png' },
    { bytes: 0 },
    { bytes: 21 },
    { bytes: NaN },
    { url: 'javascript:alert(1)' },
    { url: 'https://user:pass@example.org/' },
    { tags: ['a', 'a'] },
    { tags: null },
    { url: `https://example.org/${'é'.repeat(700)}` },
    { tags: Array(33).fill('x') },
    { tags: new Array(1) },
    { license: null },
    { license: { identifier: '' } },
    { description: '\0' },
  ])
    assert.throws(() => manager.add({ ...input(), ...patch }), code('invalid'));
  assert.equal(manager.size, 0);
});

test('options and duplicate/capacity errors are explicit', () => {
  for (const options of [
    null,
    [],
    { maxAssets: 0 },
    { maxAssets: null },
    { maxBytes: Infinity },
    { maxPendingUploads: 33 },
    { upload: 1 },
  ])
    assert.throws(() => createAssetManager(options), code('invalid'));
  const manager = createAssetManager({ maxAssets: 1 });
  manager.add(input());
  assert.throws(() => manager.add(input()), code('conflict'));
  assert.throws(() => manager.add(input('other')), code('capacity'));
});

test('uploads reserve capacity and ID until completion', async () => {
  const wait = deferred();
  const manager = createAssetManager({ maxAssets: 1, upload: () => wait.promise });
  const pending = manager.upload(upload());
  assert.equal(manager.pendingUploads, 1);
  assert.equal(manager.size, 0);
  await assert.rejects(manager.upload(upload()), code('conflict'));
  assert.throws(() => manager.add(input('other')), code('capacity'));
  wait.resolve({ url: 'https://example.org/uploaded' });
  const asset = await pending;
  assert.equal(asset.bytes, 3);
  assert.equal(asset.url, 'https://example.org/uploaded');
  assert.equal(manager.pendingUploads, 0);
});

test('uploads snapshot caller data and metadata before awaiting', async () => {
  const wait = deferred();
  let seen;
  const manager = createAssetManager({
    upload: async (value) => {
      seen = value;
      await wait.promise;
      return { url: 'https://example.org/x' };
    },
  });
  const source = upload();
  const pending = manager.upload(source);
  source.data[0] = 99;
  source.name = 'Changed';
  source.tags.push('changed');
  source.license.identifier = 'Changed';
  assert.equal(seen.data[0], 1);
  seen.data[1] = 42;
  assert.equal(source.data[1], 2);
  wait.resolve();
  const asset = await pending;
  assert.equal(asset.name, 'Logo');
  assert.deepEqual(asset.tags, ['brand']);
  assert.equal(asset.license.identifier, 'CC-BY-4.0');
});

test('pending upload bound is independent of asset bound', async () => {
  const wait = deferred();
  const manager = createAssetManager({ maxPendingUploads: 1, upload: () => wait.promise });
  const first = manager.upload(upload());
  await assert.rejects(manager.upload(upload('second')), code('capacity'));
  wait.resolve({ url: 'https://example.org/x' });
  await first;
});

test('Node Buffer uploads are copied rather than retaining a shared slice', async () => {
  const wait = deferred();
  let sent;
  const manager = createAssetManager({
    upload: async (input) => {
      sent = input.data;
      await wait.promise;
      return { url: 'https://example.org/x' };
    },
  });
  const data = Buffer.from([1, 2, 3]);
  const pending = manager.upload({ ...upload(), data });
  data[0] = 99;
  assert.equal(sent[0], 1);
  sent[1] = 88;
  assert.equal(data[1], 2);
  wait.resolve();
  await pending;
});

test('post-delivery cancellation prevents commit and releases reservation', async () => {
  const wait = deferred();
  const controller = new AbortController();
  const manager = createAssetManager({ upload: () => wait.promise });
  const pending = manager.upload(upload(), controller.signal);
  controller.abort();
  wait.resolve({ url: 'https://example.org/x' });
  await assert.rejects(pending, code('cancelled'));
  assert.equal(manager.pendingUploads, 0);
  assert.equal(manager.size, 0);
  manager.add(input());
});

test('adapter rejection and bad results release reservations', async () => {
  for (const adapter of [
    async () => {
      throw new Error('network');
    },
    async () => null,
    async () => ({ url: 'http://example.org/x' }),
  ]) {
    const manager = createAssetManager({ upload: adapter });
    await assert.rejects(manager.upload(upload()), AssetError);
    assert.equal(manager.pendingUploads, 0);
    assert.equal(manager.size, 0);
    manager.add(input());
  }
});

test('pre-abort, missing adapter and invalid buffers never call upload', async () => {
  let calls = 0;
  const manager = createAssetManager({
    maxBytes: 2,
    upload: async () => {
      calls++;
      return { url: 'https://example.org/x' };
    },
  });
  await assert.rejects(manager.upload(upload()), code('invalid'));
  await assert.rejects(manager.upload({ ...upload(), data: [] }), code('invalid'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(manager.upload(upload(), controller.signal), code('cancelled'));
  await assert.rejects(manager.upload(upload(), {}), code('invalid'));
  await assert.rejects(createAssetManager().upload(upload()), code('upload'));
  assert.equal(calls, 0);
});

test('standalone CommonJS entry matches ESM API and behavior', () => {
  const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
  assert.deepEqual(Object.keys(cjs).sort(), ['AssetError', 'createAssetManager']);
  assert.equal(cjs.createAssetManager().add(input()).revision, 1);
});
