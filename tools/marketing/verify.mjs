import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const landing = path.join(root, 'landing');
const catalog = JSON.parse(readFileSync(path.join(root, 'tools/marketing/catalog.json')));
const edits = JSON.parse(readFileSync(path.join(root, 'tools/marketing/edits.json')));
const page = readFileSync(path.join(landing, 'index.html'), 'utf8');
const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
assert.equal(catalog.length, 6);
assert.equal(new Set(catalog.map(feature => feature.id)).size, 6);
assert.equal([...page.matchAll(/data-demo-label=/g)].length, 6);
assert.equal([...page.matchAll(/<track kind="captions"/g)].length, 6);
assert.equal([...readme.matchAll(/<img src="artifacts\/marketing\/readme\//g)].length, 6);
assert.doesNotMatch(page, /<source[^>]+\.webm/);
for (const [, asset] of page.matchAll(/(?:src|poster|href)="(assets\/[^"#]+)"/g)) {
  assert(statSync(path.join(landing, asset)).isFile(), `Missing asset: ${asset}`);
}
const probe = file => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
let totalBytes = 0;
const durations = [];
for (const feature of catalog) {
  const base = path.join(landing, 'assets/videos/tour', feature.id);
  assert.equal(feature.steps.length, 3);
  const report = JSON.parse(readFileSync(`${base}.json`));
  assert.equal(report.captureKind, 'continuous-video');
  assert(report.sourceFps >= 29.9 && report.sourceFps <= 30.1);
  assert.equal(report.sourceSha256, edits[feature.id].sourceSha256);
  assert.equal(report.sourceCoverage[0], 0);
  assert(report.sourceCoverage[1] <= report.sourceSeconds);
  assert(page.includes(`id="${feature.id}"`));
  assert(readme.includes(`readme/${feature.id}.gif`));
  assert.equal(createHash('sha256').update(readFileSync(`${base}.mp4`)).digest('hex'), report.sha256);
  const captions = readFileSync(`${base}.vtt`, 'utf8');
  assert(captions.startsWith('WEBVTT\n'));
  assert.equal([...captions.matchAll(/ --> /g)].length, 3);
  for (const step of feature.steps) assert(captions.includes(step));
  const media = probe(`${base}.mp4`);
  assert.equal(media.streams.length, 1, 'Silent video only');
  const video = media.streams[0];
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.width, 1920);
  assert.equal(video.height, 1080);
  assert.equal(video.avg_frame_rate, '30/1');
  const duration = Number(media.format.duration);
  assert(duration >= 10 && duration <= 30, `${feature.id}: unexpected duration ${duration}`);
  assert(Math.abs(duration - report.duration) < .04);
  assert.equal(Number(video.nb_frames), report.frames);
  assert(report.clicks[0].outputTime >= .9 && report.clicks[0].outputTime <= 1.6, 'Brief orientation before the first click');
  for (const click of report.clicks) assert(click.outputTime < duration);
  const gif = path.join(root, `artifacts/marketing/readme/${feature.id}.gif`);
  const preview = probe(gif);
  assert.equal(preview.streams[0].width, 960);
  assert.equal(preview.streams[0].height, 540);
  assert(Math.abs(Number(preview.format.duration) - duration) < .1, 'GIF preserves the complete edit');
  assert(readFileSync(gif).includes(Buffer.from('NETSCAPE2.0\x03\x01\x00\x00\x00', 'binary')), 'GIF loops forever');
  assert(statSync(gif).size < 10 * 1024 * 1024, 'Keep inline GIF downloads bounded');
  for (const file of [`${base}.mp4`, gif]) {
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    totalBytes += statSync(file).size;
  }
  durations.push(duration);
}
const docsPath = path.join(root, 'artifacts/marketing/README.md');
const docs = readFileSync(docsPath, 'utf8');
execFileSync(process.execPath, ['tools/marketing/build-guide.mjs'], { cwd: root });
assert.equal(readFileSync(path.join(landing, 'index.html'), 'utf8'), page, 'Guide generation must be idempotent');
assert.equal(readFileSync(docsPath, 'utf8'), docs, 'Documentation generation must be idempotent');
console.log(`PASS: 6 guides, 6 decoded 1080p/30 videos, 6 complete GIF loops, captions, checksums, assets and repeatable generation. ${Math.min(...durations).toFixed(1)}–${Math.max(...durations).toFixed(1)} sec; ${(totalBytes / 1024 / 1024).toFixed(1)} MiB combined.`);
