# @lp-labs/asset-manager

Independent, bounded asset metadata and injected uploads. Version **0.1.0**, MIT, zero runtime or peer dependencies. Node 18+, ESM and CommonJS with strict TypeScript declarations.

## Install

```sh
npm install @lp-labs/asset-manager
```

## Quickstart

```js
import assert from 'node:assert/strict';
import { createAssetManager } from '@lp-labs/asset-manager';

const assets = createAssetManager({ maxAssets: 10 });
const logo = assets.add({
  id: 'logo',
  name: 'Brand mark',
  mediaType: 'image/svg+xml',
  bytes: 240,
  url: 'https://example.org/logo.svg',
  tags: ['brand'],
  license: { identifier: 'CC-BY-4.0', attribution: 'Example artist' },
});
assert.equal(assets.list('brand')[0].id, 'logo');
const edited = assets.update(logo.id, logo.revision, {
  name: 'Main logo',
  tags: ['brand', 'approved'],
  license: logo.license,
});
assert.equal(edited.revision, 2);
assert.equal(assets.remove(edited.id, edited.revision), true);
```

## API and types

Runtime exports: **`createAssetManager`**, **`AssetError`**. CJS: `const { createAssetManager } = require('@lp-labs/asset-manager')`.

| Exported type         | Contract                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `AssetLicense`        | Required `identifier`; optional `attribution` and HTTPS `url`. Descriptive metadata, not legal verification.                          |
| `AssetInput`          | `id`, `name`, lowercase parameter-free `mediaType`, positive integer `bytes`, HTTPS `url`, `license`; optional `tags`, `description`. |
| `Asset`               | Immutable `AssetInput` with normalized `tags` and positive `revision`.                                                                |
| `UploadInput`         | Asset metadata plus `data: Uint8Array`; no URL or byte-count input.                                                                   |
| `UploadAdapter`       | `(input: {id,name,mediaType,data}, signal?) => Promise<{url}>`.                                                                       |
| `AssetManagerOptions` | `maxAssets`, per-asset `maxBytes`, `maxPendingUploads`, optional `upload` adapter.                                                    |
| `AssetManager`        | Factory return interface below.                                                                                                       |

`createAssetManager(options?)` returns:

- `add(input): Asset`: inserts metadata with revision 1. No network request or file inspection.
- `get(id): Asset | undefined`: frozen asset or absent.
- `list(tag?): Asset[]`: insertion order, exact case-sensitive tag filter; fresh array.
- `update(id, revision, {name, tags?, license, description?}): Asset`: full metadata replacement. Omitted tags become empty; omitted description is removed. Content URL, byte count and media type are unchanged.
- `remove(id, revision): boolean`: requires a present asset at the exact revision; returns `true`.
- `upload(input, signal?): Promise<Asset>`: snapshots metadata and bytes, reserves capacity/ID, calls the adapter once, validates its HTTPS URL, commits only on uncancelled success. Actual input byte length becomes the asset's byte count.
- Read-only `size` and `pendingUploads`.

Assets, tags and license records are frozen and detached. Upload buffers are copied even for Node Buffers; the adapter owns its copy. No asset data bytes are retained after upload.

## Customize uploads

```js
import assert from 'node:assert/strict';
import { createAssetManager } from '@lp-labs/asset-manager';

const received = [];
const assets = createAssetManager({
  maxAssets: 2,
  maxBytes: 1024,
  maxPendingUploads: 1,
  upload: async ({ id, data }, signal) => {
    if (signal?.aborted) throw new Error('cancelled');
    received.push([...data]);
    return { url: `https://example.org/uploads/${encodeURIComponent(id)}` };
  },
});
const result = await assets.upload({
  id: 'sample',
  name: 'Sample',
  mediaType: 'text/plain',
  data: new TextEncoder().encode('hello'),
  license: { identifier: 'MIT' },
});
assert.equal(result.bytes, 5);
assert.equal(received.length, 1);
```

The example uses an in-memory adapter, not cloud storage. Supply your own authorized storage integration. URLs are validated but never fetched; HTTPS does not establish trust or prevent a caller from fetching a private address.

## Errors, races and cancellation

`AssetError(code, message, options?)` extends `Error`; `options.cause` preserves adapter failure.

| `code`      | Meaning                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `invalid`   | Malformed input/options/MIME/URL/license, duplicate tags or invalid adapter result.             |
| `capacity`  | Stored plus reserved assets or pending uploads exceed configured capacity; revision exhaustion. |
| `conflict`  | Duplicate/reserved ID, missing asset, stale revision.                                           |
| `cancelled` | Signal aborted before upload or when adapter settled; no asset committed.                       |
| `upload`    | No adapter or adapter rejection.                                                                |

Failures release reservations. Uploads of the same ID cannot race; revision guards prevent stale metadata writes. Cancellation is cooperative: an adapter ignoring its signal can continue running, and this promise waits for it to settle. Remote upload side effects cannot be rolled back; perform orphan cleanup in your adapter. No retry, timeout, deduplication by content, global byte quota, persistence or cloud backend is implied.

## Limits

| Setting             |    Default |       Allowed |
| ------------------- | ---------: | ------------: |
| `maxAssets`         |       1000 |     1..10,000 |
| `maxBytes`          | 16,777,216 | 1..67,108,864 |
| `maxPendingUploads` |          4 |         1..32 |

IDs/license identifiers: 128 UTF-16 units; names: 256; URLs/attribution/description: 2048; at most 32 unique tags of 64 units. Required strings must contain non-whitespace text without control characters. Optional values must be omitted rather than supplied as invalid values. URLs must be absolute HTTPS without credentials. Byte counts above `maxBytes` are invalid. Revision integers never wrap.

## Development

```sh
npm ci --offline
npm run build
npm run typecheck
npm test
npm run format:check
```

Dev-only TypeScript `^5.9.3` and Prettier `^3.6.2`; `format` writes formatting and `prepack` builds. Build produces `dist/esm` and `dist/cjs` with declarations. Tests import built output, exercise adapter races, and check CJS; bare `.mts`/`.cts` consumers validate both declaration branches.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
