import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { mobileAssetFiles, mobileFailureCode, serverMobileAccess } from './server-mobile-access.mjs';
import { activateRelease, installationPaths, reconcileReleaseMobileAccess } from './termloop-server-manager.mjs';
import { packageFiles, stageSourceArchive } from './server-release.mjs';

const execute = promisify(execFile);
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'termloop-server-mobile-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, paths: installationPaths({}, directory, 1000) };
}

test('enrollment uses packaged files, the server runtime and private temporary storage', async (t) => {
  const { paths } = await fixture(t);
  const assets = Object.fromEntries(mobileAssetFiles.map((name) => [name, `fixture ${name}`]));
  const code = 'TLMP1:{"private":"pairing-credential"}';
  let stage;
  const result = await serverMobileAccess('pair', paths, assets, async (node, args, options) => {
    stage = path.dirname(args[0]);
    assert.equal(node, process.execPath);
    assert.ok(args.includes('--print'));
    assert.equal(args[args.indexOf('--runtime') + 1], paths.runtime);
    assert.equal(options.env.XDG_STATE_HOME, path.dirname(paths.state));
    assert.equal(await readFile(path.join(stage, 'mobile-access.mjs'), 'utf8'), assets['mobile-access.mjs']);
    return { stdout: code + '\nTailnet endpoint: https://example.ts.net\n' };
  });
  assert.deepEqual(result, { ok: true, pairingCode: code });
  await assert.rejects(readFile(path.join(stage, 'mobile-access.mjs')), { code: 'ENOENT' });
});

test('pairing failures redact child output and remove temporary assets', async (t) => {
  const { paths } = await fixture(t);
  const assets = Object.fromEntries(mobileAssetFiles.map((name) => [name, 'fixture']));
  const failure = Object.assign(new Error('secret-pairing-token'), { stderr: 'Access denied: secret-pairing-token', stdout: 'TLMP1:private' });
  assert.deepEqual(await serverMobileAccess('pair', paths, assets, async () => { throw failure; }), { ok: false, errorCode: 'tailscalePermission' });
  assert.deepEqual(await readdir(paths.root), []);
  await assert.rejects(serverMobileAccess('reconcile', paths, assets, async () => { throw failure; }), /^Error: Mobile Access update failed \(tailscalePermission\)$/);
  assert.equal(mobileFailureCode({ stderr: 'Tailscale CLI was not found' }), 'tailscaleMissing');
  assert.equal(mobileFailureCode({ stderr: 'Tailscale is not connected' }), 'tailscaleOffline');
  assert.equal(mobileFailureCode({ killed: true }), 'timedOut');
});

test('older packages can still be installed without Mobile Access', async (t) => {
  const { directory, paths } = await fixture(t);
  await writeFile(path.join(directory, 'server-package.json'), '{}');
  await reconcileReleaseMobileAccess(directory);
  assert.deepEqual(await serverMobileAccess('pair', paths), { ok: false, errorCode: 'packageMissing' });
});

test('gateway upgrade failure restores the server and its mobile credentials', { skip: process.platform === 'win32' }, async (t) => {
  const { paths } = await fixture(t);
  const previous = { version: '2.0.5', directory: path.join(paths.releases, '2.0.5') };
  const next = { version: '2.0.6', directory: path.join(paths.releases, '2.0.6') };
  await mkdir(previous.directory, { recursive: true });
  await mkdir(next.directory);
  await mkdir(paths.state, { recursive: true });
  await symlink(previous.directory, paths.current);
  await writeFile(path.join(paths.state, 'gateway.json'), 'original-credentials');
  const events = [];
  await assert.rejects(activateRelease(paths, next, previous, {
    stop: async () => {}, start: async () => {},
    healthy: async (version) => { events.push(version); },
    reconcileMobile: async () => {
      await writeFile(path.join(paths.state, 'gateway.json'), 'changed');
      throw new Error('gateway failed');
    },
  }), /restored TermLoop 2.0.5/);
  assert.deepEqual(events, ['2.0.6', '2.0.5']);
  assert.equal(await readFile(path.join(paths.state, 'gateway.json'), 'utf8'), 'original-credentials');
});

test('Linux package includes a self-contained mobile installer without changing the legacy archive layout', { skip: process.platform === 'win32', timeout: 30_000 }, async (t) => {
  const { directory } = await fixture(t);
  const binaries = path.join(directory, 'bin');
  const output = path.join(directory, 'out');
  const stage = path.join(directory, 'unpack');
  await mkdir(binaries); await mkdir(stage);
  for (const name of ['termloop-server', 'termloop-companion', 'skills-manager-cli', 'termloopctl']) await writeFile(path.join(binaries, name), 'fixture');
  const { stdout } = await execute(process.execPath, ['tools/release/package-server.mjs', binaries, path.join(binaries, 'termloopctl'), output], { maxBuffer: 64 * 1024 });
  const unpacked = await stageSourceArchive(stdout.trim().split('\n').at(-1), stage);
  assert.deepEqual((await readdir(unpacked.payload)).filter((name) => name !== '.archive-sha256').sort(), [...packageFiles].sort());
  assert.equal(JSON.parse(await readFile(path.join(unpacked.payload, 'server-package.json'), 'utf8')).mobileAccess, 1);
  const module = await import(path.join(unpacked.payload, 'termloop-server-manager.mjs'));
  assert.equal(typeof module.activateRelease, 'function');
  const source = await readFile(path.join(unpacked.payload, 'termloop-server-manager.mjs'), 'utf8');
  assert.ok(source.includes('ai.termloop.server'));
  assert.ok(source.includes('gateway-artifact.json'));
  assert.ok(!source.includes("from './server-mobile-access.mjs'"));
});
