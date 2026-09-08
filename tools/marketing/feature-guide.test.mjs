import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesFeature, autoplayCandidate, validPlaybackRate } from '../../landing/assets/feature-guide.mjs';

test('feature search ignores case and whitespace and requires every word', () => {
  assert.equal(matchesFeature('Review a saved Workflow template', '  WORKFLOW review  '), true);
  assert.equal(matchesFeature('Review a saved Workflow template', 'workflow mobile'), false);
  assert.equal(matchesFeature('Context Bank', '   '), true);
  assert.equal(matchesFeature('Context Bank', '<script>'), false);
});
const options = { enabled: true, reducedMotion: false, pageHidden: false };
const visible = { video: 'visible', ratio: .9, hidden: false, manuallyPaused: false };
test('autoplay respects motion preference, hidden pages, and explicit opt-in', () => {
  for (const override of [{enabled:false}, {reducedMotion:true}, {pageHidden:true}])
    assert.equal(autoplayCandidate([visible], {...options,...override}), undefined);
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
