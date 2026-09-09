import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchesFeature, autoplayCandidate, validPlaybackRate, visibleVideoFraction } from '../../landing/assets/feature-guide.mjs';

test('feature search ignores case and whitespace and requires every word', () => {
  assert.equal(matchesFeature('Review a saved Workflow template', '  WORKFLOW review  '), true);
  assert.equal(matchesFeature('Review a saved Workflow template', 'workflow mobile'), false);
  assert.equal(matchesFeature('Context Bank', '   '), true);
  assert.equal(matchesFeature('Context Bank', '<script>'), false);
});
const options = { enabled: true, reducedMotion: false, pageHidden: false };
const visible = { video: 'visible', ratio: .9, hidden: false, manuallyPaused: false };
test('autoplay respects motion preference, hidden pages, and opting out', () => {
  for (const override of [{enabled:false}, {reducedMotion:true}, {pageHidden:true}])
    assert.equal(autoplayCandidate([visible], {...options,...override}), undefined);
});
test('large demos autoplay when they fill a shorter viewport', () => {
  const entry = { isIntersecting: true, boundingClientRect: { height: 1200, width: 1600 }, rootBounds: { height: 600 }, intersectionRect: { height: 500, width: 1600 } };
  const ratio = visibleVideoFraction(entry);
  assert.equal(autoplayCandidate([{ ...visible, ratio }], options), 'visible');
  assert.equal(visibleVideoFraction({ ...entry, isIntersecting: false }), 0);
  assert.equal(visibleVideoFraction({ ...entry, intersectionRect: { height: 200, width: 1600 } }), 1 / 3);
  assert.equal(visibleVideoFraction({ ...entry, boundingClientRect: { height: 0, width: 0 } }), 0);
});
test('all published feature demos loop silently and autoplay is enabled by default', () => {
  const page = readFileSync(new URL('../../landing/index.html', import.meta.url), 'utf8');
  assert.match(page, /id="demo-autoplay" checked/);
  const demos = [...page.matchAll(/<video[^>]+aria-label="[^"]+ demonstration"[^>]*>/g)];
  assert.equal(demos.length, 32);
  for (const [tag] of demos) {
    assert.match(tag, / muted /);
    assert.match(tag, / loop /);
    assert.match(tag, / playsinline /);
  }
});
test('autoplay never resumes a manually paused, filtered, or mostly offscreen demo', () => {
  for (const override of [{manuallyPaused:true}, {hidden:true}, {ratio:.54}])
    assert.equal(autoplayCandidate([{...visible,...override}], options), undefined);
});
test('only the most visible eligible video is selected', () => {
  assert.equal(autoplayCandidate([{...visible,video:'other',ratio:.6}, visible], options), 'visible');
  assert.equal(autoplayCandidate([], options), undefined);
});
test('playback rates stay within the offered readable range', () => {
  for (const rate of ['0.75','1','1.25','1.5']) assert.equal(validPlaybackRate(rate), Number(rate));
  for (const rate of ['0','-1','5','NaN','']) assert.equal(validPlaybackRate(rate), 1);
});
