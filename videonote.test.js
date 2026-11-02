import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CIRCLE_MAX_SECONDS, CIRCLE_PREFIX, isCircleMedia } from '../public/js/views/videonote.js';

test('marks only explicitly named circle videos as video notes', () => {
  assert.equal(isCircleMedia({ filename: `${CIRCLE_PREFIX}123.webm` }), true);
  assert.equal(isCircleMedia({ filename: 'square-video.webm', width: 480, height: 480, duration: 12 }), false);
  assert.equal(isCircleMedia({ filename: 'circle-123.webm.backup' }), true);
  assert.equal(isCircleMedia(null), false);
  assert.equal(CIRCLE_MAX_SECONDS, 60);
});
