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
test('the separate mic switch stays clickable at every bot size and pill width', () => {
  // Layout model of .overlay-dock: left 8%, width 84%, [26px mic][8px gap][pill], centred; pill is 70..125px wide
  // ("Right here" up to "Taking a breath"); dock bottom at 4%, mic is 26px high.
  for (const [width, height] of Object.values(BOT_DIMENSIONS)) {
    for (const pill of [70, 95, 125]) {
      const dockLeft = width * .08, dockWidth = width * .84, content = 26 + 8 + pill;
      const micLeft = dockLeft + (dockWidth - content) / 2;
      const midY = height * .96 - 13;
      for (const panel of [null, 'caption', 'consent', 'approval']) {
        const shape = overlayShape(width, height, panel);
        for (const x of [micLeft + 1, micLeft + 13, micLeft + 25]) assert.ok(contains(shape, x, midY), `mic hit box missed at x=${x} (${width}, pill ${pill}, panel ${panel})`);
      }
    }
  }
});
