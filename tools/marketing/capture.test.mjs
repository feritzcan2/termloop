import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { waitForFinalizedFile } from './capture.mjs';

test('waits for trailing recording data before accepting the file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termloop-recording-test-'));
  const file = path.join(root, 'recording.mkv');
  try {
    await writeFile(file, 'header');
    const done = waitForFinalizedFile(file);
    await new Promise(resolve => setTimeout(resolve, 700));
    await writeFile(file, 'header and final video frames');
    await done;
    assert.equal(await readFile(file, 'utf8'), 'header and final video frames');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects unknown feature IDs before connecting to or stopping OBS', () => {
  const result = spawnSync(process.execPath, ['tools/marketing/capture.mjs', 'stop', '../invalid'], {
    encoding: 'utf8', env: { ...process.env, TERMLOOP_OBS_CONFIG: '/not-an-obs-config' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Use a new feature ID/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});
