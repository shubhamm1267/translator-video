import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioFitPlan } from '../src/audio-fit.mjs';
import { captionSegments } from '../src/media.mjs';

test('26.1s video with 19.9s Cartesia triggers an automatic rewrite rather than error', () => {
  const result = audioFitPlan(19.9, 26.1);
  assert.equal(result.needsRewrite, true);
  assert.equal(result.tempo, 1);
  assert.ok(result.remainingSeconds > 5.5);
});
test('well matched audio needs no AI retries', () => {
  const result = audioFitPlan(25, 26.1);
  assert.equal(result.needsRewrite, false);
  assert.equal(result.tempo, 1);
  assert.ok(result.remainingSeconds < 1.2);
});
test('long audio requests an auto-shortening pass', () => {
  const result = audioFitPlan(33, 26.1);
  assert.equal(result.needsRewrite, true);
  assert.ok(result.tempo <= 1.50);
});
test('captions stop with narration instead of spreading over silent footage', () => {
  const script = { language: 'en', beats: [
    {start:0,end:11,text:'An engaging first sentence'},
    {start:11,end:26.1,text:'Then the amazing last demonstration'}
  ]};
  const c = captionSegments(script, 23.14);
  assert.ok(c.length);
  assert.ok(c.at(-1).end <= 23.14);
  assert.ok(c.at(-1).end > 22.9);
});
