export interface AssetLicense {
  readonly identifier: string;
  readonly attribution?: string;
  readonly url?: string;
}

export interface AssetInput {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly url: string;
  readonly tags?: readonly string[];
  readonly license: AssetLicense;
  readonly description?: string;
}

export interface Asset extends AssetInput {
  readonly revision: number;
  readonly tags: readonly string[];
}

export interface UploadInput {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly data: Uint8Array;
  readonly tags?: readonly string[];
  readonly license: AssetLicense;
  readonly description?: string;
}

export type UploadAdapter = (
  input: Readonly<{ id: string; name: string; mediaType: string; data: Uint8Array }>,
  signal?: AbortSignal,
) => Promise<{ readonly url: string }>;

export interface AssetManagerOptions {
  readonly maxAssets?: number;
  readonly maxBytes?: number;
  readonly maxPendingUploads?: number;
  readonly upload?: UploadAdapter;
}

export interface AssetManager {
  add(input: AssetInput): Asset;
  get(id: string): Asset | undefined;
  list(tag?: string): Asset[];
  update(
    id: string,
    revision: number,
    metadata: Pick<AssetInput, 'name' | 'tags' | 'license' | 'description'>,
  ): Asset;
  remove(id: string, revision: number): boolean;
  upload(input: UploadInput, signal?: AbortSignal): Promise<Asset>;
  readonly size: number;
  readonly pendingUploads: number;
}

export class AssetError extends Error {
  constructor(
    readonly code: 'invalid' | 'capacity' | 'conflict' | 'cancelled' | 'upload',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AssetError';
  }
}

function text(value: unknown, name: string, limit = 128): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > limit ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new AssetError(
      'invalid',
      `${name} must be nonempty text up to ${limit} characters without controls.`,
    );
}

function count(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new AssetError('invalid', `${name} must be an integer from 1 to ${maximum}.`);
  return value;
}

function safeUrl(value: string): string {
  text(value, 'URL', 2048);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AssetError('invalid', 'URL must be absolute HTTPS.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new AssetError('invalid', 'Only HTTPS URLs without credentials are supported.');
  text(parsed.href, 'Normalized URL', 2048);
  return parsed.href;
}

function metadata(input: Pick<AssetInput, 'name' | 'tags' | 'license' | 'description'>) {
  text(input.name, 'Name', 256);
  if (!input.license || typeof input.license !== 'object')
    throw new AssetError('invalid', 'License metadata is required.');
  text(input.license.identifier, 'License identifier');
  if (input.license.attribution !== undefined) text(input.license.attribution, 'Attribution', 2048);
  if (input.description !== undefined) text(input.description, 'Description', 2048);
  const tags = input.tags === undefined ? [] : input.tags;
  if (!Array.isArray(tags) || tags.length > 32)
    throw new AssetError('invalid', 'At most 32 tags are supported.');
  const normalized: string[] = [];
  for (const tag of tags) {
    text(tag, 'Tag', 64);
    if (normalized.includes(tag))
      throw new AssetError('invalid', 'Duplicate tags are not supported.');
    normalized.push(tag);
  }
  return {
    name: input.name,
    tags: Object.freeze(normalized),
    license: Object.freeze({
      identifier: input.license.identifier,
      ...(input.license.attribution === undefined
        ? {}
        : { attribution: input.license.attribution }),
      ...(input.license.url === undefined ? {} : { url: safeUrl(input.license.url) }),
    }),
    ...(input.description === undefined ? {} : { description: input.description }),
  };
}

function mediaType(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length > 128 ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(value)
  )
    throw new AssetError('invalid', 'mediaType must be a lowercase MIME type without parameters.');
}

function checkSignal(signal: AbortSignal | undefined): void {
  if (
    signal !== undefined &&
    (!signal ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function')
  )
    throw new AssetError('invalid', 'signal must be an AbortSignal.');
  if (signal?.aborted)
    throw new AssetError('cancelled', 'Upload cancelled; no asset was committed.');
}

export function createAssetManager(options: AssetManagerOptions = {}): AssetManager {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new AssetError('invalid', 'Options must be an object.');
  const maxAssets = count(
    options.maxAssets === undefined ? 1000 : options.maxAssets,
    'maxAssets',
    10_000,
  );
  const maxBytes = count(
    options.maxBytes === undefined ? 16_777_216 : options.maxBytes,
    'maxBytes',
    67_108_864,
  );
  const maxPending = count(
    options.maxPendingUploads === undefined ? 4 : options.maxPendingUploads,
    'maxPendingUploads',
    32,
  );
  if (options.upload !== undefined && typeof options.upload !== 'function')
    throw new AssetError('invalid', 'upload must be an adapter function.');
  const adapter = options.upload;
  const assets = new Map<string, Asset>();
  const pending = new Set<string>();
  const available = (id: string) => {
    text(id, 'ID');
    if (assets.has(id) || pending.has(id))
      throw new AssetError('conflict', `ID ${id} is already present or reserved.`);
    if (assets.size + pending.size >= maxAssets)
      throw new AssetError('capacity', 'Asset capacity is full.');
  };
  const normalize = (input: AssetInput, revision: number): Asset => {
    if (!input || typeof input !== 'object')
      throw new AssetError('invalid', 'Asset input is required.');
    text(input.id, 'ID');
    mediaType(input.mediaType);
    count(input.bytes, 'bytes', maxBytes);
    return Object.freeze({
      id: input.id,
      mediaType: input.mediaType,
      bytes: input.bytes,
      url: safeUrl(input.url),
      ...metadata(input),
      revision,
    });
  };
  const existing = (id: string, revision: number): Asset => {
    text(id, 'ID');
    count(revision, 'revision', Number.MAX_SAFE_INTEGER);
    const asset = assets.get(id);
    if (!asset || asset.revision !== revision)
      throw new AssetError('conflict', 'Asset is missing or revision is stale.');
    return asset;
  };
  return Object.freeze({
    add(input: AssetInput): Asset {
      const asset = normalize(input, 1);
      available(asset.id);
      assets.set(asset.id, asset);
      return asset;
    },
    get(id: string): Asset | undefined {
      text(id, 'ID');
      return assets.get(id);
    },
    list(tag?: string): Asset[] {
      if (tag !== undefined) text(tag, 'Tag', 64);
      return [...assets.values()].filter((asset) => tag === undefined || asset.tags.includes(tag));
    },
    update(
      id: string,
      revision: number,
      input: Pick<AssetInput, 'name' | 'tags' | 'license' | 'description'>,
    ): Asset {
      const old = existing(id, revision);
      if (!input || typeof input !== 'object')
        throw new AssetError('invalid', 'Metadata is required.');
      if (old.revision === Number.MAX_SAFE_INTEGER)
        throw new AssetError('capacity', 'Revision is exhausted.');
      const { description: _description, ...rest } = old;
      const asset: Asset = Object.freeze({
        ...rest,
        ...metadata(input),
        revision: old.revision + 1,
      });
      assets.set(id, asset);
      return asset;
    },
    remove(id: string, revision: number): boolean {
      existing(id, revision);
      return assets.delete(id);
    },
    async upload(input: UploadInput, signal?: AbortSignal): Promise<Asset> {
      checkSignal(signal);
      if (!adapter) throw new AssetError('upload', 'An upload adapter must be supplied.');
      if (!input || typeof input !== 'object' || !(input.data instanceof Uint8Array))
        throw new AssetError('invalid', 'Upload data must be a Uint8Array.');
      count(input.data.byteLength, 'bytes', maxBytes);
      const data = new Uint8Array(input.data);
      // Snapshot metadata before yielding; adapters never receive the caller's buffer.
      const prepared = normalize(
        { ...input, bytes: data.byteLength, url: 'https://pending.invalid/' },
        1,
      );
      available(prepared.id);
      if (pending.size >= maxPending)
        throw new AssetError('capacity', 'Pending upload capacity is full.');
      pending.add(prepared.id);
      try {
        let result: { readonly url: string };
        try {
          result = await adapter(
            Object.freeze({
              id: prepared.id,
              name: prepared.name,
              mediaType: prepared.mediaType,
              data,
            }),
            signal,
          );
        } catch (cause) {
          checkSignal(signal);
          throw new AssetError('upload', 'Upload adapter failed; no asset was committed.', {
            cause,
          });
        }
        checkSignal(signal);
        if (!result || typeof result !== 'object')
          throw new AssetError('invalid', 'Upload adapter must return a URL.');
        const asset = Object.freeze({ ...prepared, url: safeUrl(result.url) });
        assets.set(asset.id, asset);
        return asset;
      } finally {
        pending.delete(prepared.id);
      }
    },
    get size() {
      return assets.size;
    },
    get pendingUploads() {
      return pending.size;
    },
  });
}
