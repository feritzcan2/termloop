import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const landing = path.join(root, 'landing');
const catalog = JSON.parse(readFileSync(path.join(root, 'tools/marketing/catalog.json')));
const page = readFileSync(path.join(landing, 'index.html'), 'utf8');
assert.equal(catalog.length, 32);
assert.equal(new Set(catalog.map(feature => feature.id)).size, 32);
assert.equal(catalog.filter(feature => !feature.legacy).length, 22);
assert.equal([...page.matchAll(/class="feature-story"/g)].length, 32);
assert.equal([...page.matchAll(/<track kind="captions"/g)].length, 32);
for (const [, asset] of page.matchAll(/(?:src|poster|href)="(assets\/[^"#]+)"/g)) {
  assert(statSync(path.join(landing, asset)).isFile(), `Missing asset: ${asset}`);
}
let totalBytes = 0;
let minDuration = Infinity;
let maxDuration = 0;
for (const feature of catalog) {
  const base = path.join(landing, 'assets/videos/tour', feature.id);
  assert.equal(feature.steps.length, 3);
  const timing = JSON.parse(readFileSync(`${base}.json`));
  assert.equal(timing.captureKind, 'continuous-video');
  assert.equal(timing.motionSpeed, 1);
  assert(timing.sourceFps >= (feature.legacy ? 15 : 29), `${feature.id}: source capture rate too low`);
  assert(page.includes(`id="${feature.id}"`), `Missing guide: ${feature.id}`);
  const report = timing;
  assert.equal(createHash('sha256').update(readFileSync(`${base}.mp4`)).digest('hex'), report.sha256);
  const captions = readFileSync(`${base}.vtt`, 'utf8');
  assert(captions.startsWith('WEBVTT\n'));
  assert.equal([...captions.matchAll(/ --> /g)].length, 3);
  for (const step of feature.steps) assert(captions.includes(step));
  for (const extension of ['mp4', 'webm']) {
    const file = `${base}.${extension}`;
    const media = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
    const video = media.streams.find(stream => stream.codec_type === 'video');
    assert.equal(video.codec_name, extension === 'mp4' ? 'h264' : 'vp9');
    assert.equal(video.width, 1920);
    assert.equal(video.height, 1248);
    assert.equal(video.avg_frame_rate, '30/1');
    const duration = Number(media.format.duration);
    assert(duration >= 8.9 && duration <= 60, `${feature.id}: unexpected duration ${duration}`);
    assert(Math.abs(duration - report.duration) < .1, `${feature.id}: format durations differ`);
    assert(statSync(file).size < 25 * 1024 * 1024, 'Pages per-file size limit');
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    totalBytes += statSync(file).size;
    minDuration = Math.min(minDuration, duration);
    maxDuration = Math.max(maxDuration, duration);
  }
}
const docsPath = path.join(root, 'artifacts/marketing/README.md');
const docs = readFileSync(docsPath, 'utf8');
execFileSync(process.execPath, ['tools/marketing/build-guide.mjs'], { cwd: root });
assert.equal(readFileSync(path.join(landing, 'index.html'), 'utf8'), page, 'Guide generation must be idempotent');
assert.equal(readFileSync(docsPath, 'utf8'), docs, 'Documentation generation must be idempotent');
console.log(`PASS: 32 guides, 22 current recordings, 64 decoded videos, captions/assets/checksums, and repeatable generation. ${minDuration.toFixed(1)}–${maxDuration.toFixed(1)} sec; ${(totalBytes / 1024 / 1024).toFixed(1)} MiB total video delivery.`);
