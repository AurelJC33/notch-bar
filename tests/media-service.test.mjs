import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeState } = require('../media-service.js');

test('normalizeState exposes one canonical media shape', () => {
  const state = normalizeState({
    available: true,
    playing: true,
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    artworkUrl: 'data:image/png;base64,AAAA',
    sourceApp: 'Deezer.exe',
    position: 83.2,
    duration: 241.7,
    timelineUpdatedAtMs: 1234,
    canPlay: true,
    canPause: true,
    canNext: true,
    canPrevious: false,
    canSeek: true,
  });

  assert.equal(state.available, true);
  assert.equal(state.playing, true);
  assert.equal(state.isPlaying, true);
  assert.equal(state.positionSeconds, 83.2);
  assert.equal(state.durationSeconds, 241.7);
  assert.equal(state.cover, 'data:image/png;base64,AAAA');
  assert.equal(state.source, 'Deezer.exe');
  assert.equal(state.canPrevious, false);
});

test('normalizeState does not invent media data when unavailable', () => {
  const state = normalizeState(null);
  assert.equal(state.available, false);
  assert.equal(state.title, '');
  assert.equal(state.artworkUrl, null);
  assert.equal(state.canSeek, false);
});
