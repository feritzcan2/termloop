// Continuous recording through OBS Studio's authenticated WebSocket API.
// Configure a window-only source and 30 FPS in OBS; perform demo actions in the app.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('base64');

export async function connectOBS(configPath) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert(config.auth_required, 'Enable OBS WebSocket authentication before recording');
  const socket = new WebSocket(`ws://127.0.0.1:${config.server_port}`);
  let sequence = 0;
  const pending = new Map();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error('OBS connection timed out')); }, 10000);
    socket.onerror = () => { clearTimeout(timeout); reject(new Error('Could not connect to OBS')); };
    socket.onmessage = ({ data }) => {
      const { op, d } = JSON.parse(data);
      if (op === 0) {
        if (!d.authentication) { clearTimeout(timeout); socket.close(); reject(new Error('OBS must require authentication')); return; }
        const authentication = hash(hash(config.server_password + d.authentication.salt) + d.authentication.challenge);
        socket.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 0, authentication } }));
      }
      if (op === 2) { clearTimeout(timeout); resolve(); }
      if (op === 7) {
        const request = pending.get(d.requestId);
        if (!request) return;
        clearTimeout(request.timeout);
        pending.delete(d.requestId);
        if (d.requestStatus.result) request.resolve(d.responseData);
        else request.reject(new Error(`${d.requestType}: ${d.requestStatus.code} ${d.requestStatus.comment ?? ''}`));
      }
    };
  });
  return {
    call(requestType, requestData = {}) {
      const requestId = String(sequence++);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`${requestType} timed out`)); }, 10000);
        pending.set(requestId, { resolve, reject, timeout });
        socket.send(JSON.stringify({ op: 6, d: { requestId, requestType, requestData } }));
      });
    },
    close() { socket.close(); },
  };
}

export async function waitForFinalizedFile(file) {
  let previousSize = -1;
  let stable = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(250);
    const size = (await stat(file)).size;
    stable = size > 0 && size === previousSize ? stable + 1 : 0;
    if (stable >= 4) return;
    previousSize = size;
  }
  throw new Error('OBS recording did not finish writing');
}

async function main() {
  const [command, id] = process.argv.slice(2);
  assert(['start', 'stop', 'status'].includes(command), 'Usage: node tools/marketing/capture.mjs start|stop <feature-id>|status');
  const catalog = JSON.parse(await readFile(new URL('./catalog.json', import.meta.url), 'utf8'));
  const root = process.env.TERMLOOP_MARKETING_RECORDINGS;
  if (command === 'stop') {
    assert(catalog.some(feature => feature.id === id && !feature.legacy), 'Use a new feature ID from catalog.json');
    assert(root, 'Set TERMLOOP_MARKETING_RECORDINGS to a directory outside the repository');
  }
  const config = process.env.TERMLOOP_OBS_CONFIG ?? path.join(os.homedir(), 'Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json');
  const obs = await connectOBS(config);
  try {
    if (command === 'status') { console.log(await obs.call('GetRecordStatus')); return; }
    if (command === 'start') {
      const video = await obs.call('GetVideoSettings');
      assert.equal(video.fpsNumerator / video.fpsDenominator, 30, 'Use actual 30 FPS capture');
      assert(video.outputWidth >= 1920, 'Use a 1920px or wider recording');
      await obs.call('StartRecord');
      await delay(1000);
      assert((await obs.call('GetRecordStatus')).outputActive, 'OBS failed to start; inspect its output settings');
      console.log('Continuous recording started');
      return;
    }
    const { outputPath } = await obs.call('StopRecord');
    await waitForFinalizedFile(outputPath);
    const stats = await obs.call('GetStats');
    assert.equal(stats.outputSkippedFrames, 0, 'OBS dropped encoding frames; lower load and record again');
    await mkdir(root, { recursive: true });
    const target = path.join(root, `${id}.mp4`);
    execFileSync('ffmpeg', ['-v', 'error', '-n', '-i', outputPath, '-map', '0:v:0', '-c', 'copy', target]);
    await writeFile(path.join(root, `${id}.capture.json`), JSON.stringify({ recorder: 'OBS Studio', source: outputPath, stats }, null, 2) + '\n');
    console.log(`Saved ${target}`);
  } finally { obs.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
