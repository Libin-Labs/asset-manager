import { createAssetManager, AssetError } from '@lp-labs/asset-manager';
import type {
  Asset,
  AssetInput,
  AssetLicense,
  UploadInput,
  UploadAdapter,
  AssetManagerOptions,
  AssetManager,
} from '@lp-labs/asset-manager';
const license: AssetLicense = { identifier: 'MIT' };
const input: AssetInput = {
  id: 'a',
  name: 'A',
  mediaType: 'text/plain',
  bytes: 1,
  url: 'https://example.org/a',
  license,
};
const adapter: UploadAdapter = async () => ({ url: 'https://example.org/a' });
const options: AssetManagerOptions = { upload: adapter };
const manager: AssetManager = createAssetManager(options);
const asset: Asset = manager.add(input);
const upload: UploadInput = {
  id: 'b',
  name: 'B',
  mediaType: 'text/plain',
  data: new Uint8Array([1]),
  license,
};
void manager.upload(upload);
void manager.update(asset.id, asset.revision, { name: 'A', license });
void new AssetError('conflict', 'stale');
// @ts-expect-error bytes must be numeric
const invalid: AssetInput = { ...input, bytes: '1' };
void invalid;
