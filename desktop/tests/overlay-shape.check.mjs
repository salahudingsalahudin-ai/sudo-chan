import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlayShape } from '../dist/shared/overlay-shape.js';
import { BOT_DIMENSIONS } from '../dist/shared/validation.js';

const contains = (rects, x, y) => rects.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);

test('every bot size accepts body, grip and both dock controls while corners pass through', () => {
  for (const [width, height] of Object.values(BOT_DIMENSIONS)) {
    const shape = overlayShape(width, height, false);
    for (const [x, y] of [[.5, .5], [.5, .16], [.35, .91], [.82, .91], [.94, .91]]) {
      assert.ok(contains(shape, width * x, height * y), `Missing control at ${x},${y} for ${width}`);
    }
    assert.equal(contains(shape, 1, 1), false);
    assert.equal(contains(shape, width - 1, height - 1), false);
    for (const r of shape) {
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= width && r.y + r.height <= height);
    }
  }
});
test('greeting region is interactive only while a speech bubble exists', () => {
  assert.equal(contains(overlayShape(220, 260, false), 110, 5), false);
  assert.equal(contains(overlayShape(220, 260, true), 110, 5), true);
});
