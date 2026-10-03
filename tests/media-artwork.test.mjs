import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'media-service.ps1'), 'utf8');

test('media artwork uses the native GSMTC Thumbnail stream and validates image data', () => {
  assert.match(source, /props\.Thumbnail/);
  assert.match(source, /OpenReadAsync/);
  assert.match(source, /artwork-content-type-unknown/);
  assert.match(source, /data:\$contentType;base64/);
});

test('album artwork cache is keyed by album rather than only track title', () => {
  assert.match(source, /\$artworkKey\s*=\s*if \(\$album\)/);
  assert.match(source, /\$albumArtist/);
});
