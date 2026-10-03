import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeState, reconcileState, shouldEmitMediaUpdate } = require('../media-service.js');

function track(overrides = {}) {
  return normalizeState({
    available: true,
    playing: true,
    title: 'A track',
    artist: 'An artist',
    album: 'An album',
    sourceApp: 'player.exe',
    artworkUrl: 'data:image/jpeg;base64,AAAA',
    artworkResolved: true,
    duration: 240,
    canPause: true,
    canTogglePlayPause: true,
    canSeek: true,
    ...overrides,
  });
}

test('same-track metadata sync preserves the loaded artwork', () => {
  const previous = track({ position: 24, timelineUpdatedAtMs: 1000 });
  const nativeSyncWithoutArtwork = track({
    position: 24.35,
    timelineUpdatedAtMs: 1350,
    artworkUrl: null,
    cover: '',
    artworkResolved: true,
  });

  const result = reconcileState(previous, nativeSyncWithoutArtwork);
  assert.equal(result.artworkUrl, previous.artworkUrl);
  assert.equal(result.cover, previous.cover);
});

test('timeline-only GSMTC samples do not trigger renderer work', () => {
  const previous = track({ position: 24, timelineUpdatedAtMs: 1000 });
  const timelineOnly = track({ position: 24.35, timelineUpdatedAtMs: 1350 });

  assert.equal(shouldEmitMediaUpdate(previous, timelineOnly), false);
  assert.equal(shouldEmitMediaUpdate(previous, track({ title: 'Next track' })), true);
});
