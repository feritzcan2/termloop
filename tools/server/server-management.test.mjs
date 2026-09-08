import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readlink, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { activateRelease, currentRelease, installationPaths, pruneReleases, runManager, serviceDefinitions } from './termloop-server-manager.mjs';
import { newerVersion, packageFiles, parseVersion, resolveRelease, stageRelease, stageSourceArchive, validateArchiveListing } from './server-release.mjs';

const execute = promisify(execFile);
const native = { skip: process.platform === 'win32' ? 'Linux server filesystem management uses Unix symlinks and tar' : false };
async function fixture(context) {
  const directory = await mkdtemp(path.join(tmpdir(), 'termloop-server-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const paths = installationPaths({ XDG_DATA_HOME: directory, XDG_STATE_HOME: directory, XDG_CONFIG_HOME: directory, XDG_RUNTIME_DIR: directory }, directory, 1000);
  await mkdir(paths.releases, { recursive: true });
  return paths;
}
async function release(paths, version) {
  const directory = path.join(paths.releases, version);
  await mkdir(directory);
  await writeFile(path.join(directory, 'server-package.json'), JSON.stringify({ schema: 1, version }));
  return { version, directory };
}

test('stable version comparison prevents prereleases, unsafe tags and automatic downgrades', () => {
  assert(newerVersion('2.1.0', '2.0.9'));
  assert(newerVersion('2.0.10', '2.0.9'));
  assert(!newerVersion('2.0.1', '2.0.1'));
  assert(!newerVersion('1.9.0', '2.0.1'));
  for (const value of ['../2.0.1', 'v2.0.1', '2.0.1-beta', '02.0.1', '2.0', '999999999999999999.0.1']) assert.throws(() => parseVersion(value));
});

test('release resolution requires exact repository assets and one matching checksum', async () => {
  const version = '2.0.2';
  const archive = `termloop-server-linux-x64-${version}.tar.gz`;
  const base = `https://github.com/feritzcan2/termloop/releases/download/v${version}/`;
  const metadata = { tag_name: `v${version}`, draft: false, prerelease: false, assets: [archive, 'SHA256SUMS'].map((name) => ({ name, browser_download_url: base + name })) };
  let sums = `${'a'.repeat(64)}  ${archive}\n`;
  const request = async (url) => new Response(url.endsWith('SHA256SUMS') ? sums : JSON.stringify(metadata));
  const resolved = await resolveRelease(undefined, request);
  assert.equal(resolved.version, version);
  assert.equal(resolved.sha256, 'a'.repeat(64));
  sums += sums;
  await assert.rejects(resolveRelease(undefined, request), /exactly one/);
  metadata.assets[0].browser_download_url = 'https://untrusted.invalid/payload';
  await assert.rejects(resolveRelease(undefined, request), /missing the supported server asset/);
});

test('archives reject traversal, duplicate files and links', () => {
  const names = ['./', ...packageFiles.map((name) => './' + name)].join('\n');
  const modes = 'drwxr-xr-x owner/group 0 2026-01-01 00:00 ./\n' + packageFiles.map((name) => `-rwxr-xr-x owner/group 1 2026-01-01 00:00 ./${name}`).join('\n');
  validateArchiveListing(names, modes);
  assert.throws(() => validateArchiveListing(names + '\n../outside', modes), /Unexpected/);
  assert.throws(() => validateArchiveListing(names + '\n./termloop-server', modes), /duplicate/);
  assert.throws(() => validateArchiveListing(names, modes.replace('-rwx', 'lrwx')), /regular files/);
});

test('downloaded archive is verified and unpacked only after checksum validation', native, async (context) => {
  const paths = await fixture(context);
  const source = path.join(paths.root, 'source');
  const stage = path.join(paths.root, 'stage');
  await mkdir(source); await mkdir(stage);
  for (const file of packageFiles) await writeFile(path.join(source, file), 'fixture');
  await writeFile(path.join(source, 'server-package.json'), JSON.stringify({ schema: 1, version: '2.0.2', platform: 'linux', arch: 'x64', target: 'x86_64-unknown-linux-musl', commit: 'a'.repeat(40) }));
  const archive = path.join(paths.root, 'fixture.tar.gz');
  await execute('tar', ['-C', source, '-czf', archive, '.']);
  const bytes = await readFile(archive);
  const metadata = { version: '2.0.2', url: 'https://example.invalid/archive', sha256: createHash('sha256').update(bytes).digest('hex') };
  const request = async () => new Response(bytes);
  await assert.rejects(stageRelease({ ...metadata, sha256: '0'.repeat(64) }, stage, request), /checksum mismatch/);
  const payload = await stageRelease(metadata, stage, request);
  assert.equal(await readFile(path.join(payload, 'termloop-server'), 'utf8'), 'fixture');
  assert.equal((await readFile(path.join(payload, '.archive-sha256'), 'utf8')).trim(), metadata.sha256);
});

test('failed startup restores the previous executable and all snapshotted state', native, async (context) => {
  const paths = await fixture(context);
  const previous = await release(paths, '2.0.1');
  const next = await release(paths, '2.0.2');
  await symlink('releases/2.0.1', paths.current);
  await mkdir(paths.state);
  await writeFile(path.join(paths.state, 'state.v1.json'), 'original-state');
  await writeFile(path.join(paths.state, 'access.json'), 'original-pairing');
  const events = [];
  const service = {
    stop: async () => events.push('stop'),
    start: async () => events.push('start'),
    healthy: async (version) => {
      events.push(version);
      if (version === next.version) {
        await writeFile(path.join(paths.state, 'state.v1.json'), 'incompatible-state');
        await writeFile(path.join(paths.state, 'new-file'), 'new');
        throw new Error('candidate crashed');
      }
    },
  };
  await assert.rejects(activateRelease(paths, next, previous, service), /restored TermLoop 2.0.1/);
  assert.equal((await currentRelease(paths)).version, '2.0.1');
  assert.equal(await readFile(path.join(paths.state, 'state.v1.json'), 'utf8'), 'original-state');
  assert.equal(await readFile(path.join(paths.state, 'access.json'), 'utf8'), 'original-pairing');
  await assert.rejects(readFile(path.join(paths.state, 'new-file')), { code: 'ENOENT' });
  assert.deepEqual(events, ['stop', 'start', '2.0.2', 'stop', 'start', '2.0.1']);
});

test('successful activation preserves data and records the prior state snapshot', native, async (context) => {
  const paths = await fixture(context);
  const previous = await release(paths, '2.0.1');
  const next = await release(paths, '2.0.2');
  await symlink('releases/2.0.1', paths.current);
  await mkdir(paths.state);
  await writeFile(path.join(paths.state, 'state.v1.json'), 'data');
  await activateRelease(paths, next, previous, { stop: async () => {}, start: async () => {}, healthy: async () => {} });
  assert.equal((await currentRelease(paths)).version, next.version);
  assert.equal(await readFile(path.join(paths.state, 'state.v1.json'), 'utf8'), 'data');
  assert.equal(await readFile(path.join(paths.root, 'state-before-update/state.v1.json'), 'utf8'), 'data');
});

test('failed first startup leaves no installed current release', native, async (context) => {
  const paths = await fixture(context);
  const next = await release(paths, '2.0.2');
  await assert.rejects(activateRelease(paths, next, undefined, { stop: async () => {}, start: async () => {}, healthy: async () => { throw new Error('failed'); } }));
  assert.equal(await currentRelease(paths), undefined);
});

test('installed symlinks cannot point outside owned version directories', native, async (context) => {
  const paths = await fixture(context);
  await symlink('../outside', paths.current);
  await assert.rejects(currentRelease(paths), /outside the managed/);
  assert.equal(await readlink(paths.current), '../outside');
});

test('service follows current symlink and configures a persistent hourly timer', () => {
  const paths = installationPaths({}, '/home/runner', 1000);
  const units = serviceDefinitions(paths, '/usr/local/bin/node', { PATH: '/usr/bin' });
  assert.match(units['termloop-next.service'], /current\/termloop-server/);
  assert.match(units['termloop-next.service'], /KillMode=mixed/);
  assert.match(units['termloop-next-update.service'], /current\/termloop-server-manager.mjs.*update/);
  assert.match(units['termloop-next-update.timer'], /OnCalendar=hourly/);
  assert.match(units['termloop-next-update.timer'], /Persistent=true/);
});

test('service paths preserve literal dollar signs and custom runtime discovery', () => {
  const paths = installationPaths({ XDG_RUNTIME_DIR: '/run/custom' }, '/home/user$account', 1000);
  const units = serviceDefinitions(paths, '/opt/node$/bin/node', { PATH: '/usr/bin' });
  assert.match(units['termloop-next.service'], /ExecStart="\/home\/user\$\$account/);
  assert.match(units['termloop-next.service'], /Environment="PATH=\/home\/user\$account/);
  assert.match(units['termloop-next-update.service'], /ExecStart="\/opt\/node\$\$\/bin\/node"/);
  assert.match(units['termloop-next-update.service'], /Environment="XDG_RUNTIME_DIR=\/run\/custom"/);
});

test('snapshot failure restarts the unchanged previous server', native, async (context) => {
  const paths = await fixture(context);
  const previous = await release(paths, '2.0.1');
  const next = await release(paths, '2.0.2');
  await symlink('releases/2.0.1', paths.current);
  await symlink(paths.releases, paths.state);
  const events = [];
  await assert.rejects(activateRelease(paths, next, previous, {
    stop: async () => events.push('stop'), start: async () => events.push('start'), healthy: async (version) => events.push(version),
  }), /Refusing to snapshot/);
  assert.equal((await currentRelease(paths)).version, previous.version);
  assert.deepEqual(events, ['stop', 'start', '2.0.1']);
});

async function sourcePackage(paths, overrides = {}) {
  const directory = await mkdtemp(path.join(paths.root, 'source-package-'));
  const payload = path.join(directory, 'payload');
  await mkdir(payload);
  for (const name of packageFiles) await writeFile(path.join(payload, name), 'fixture');
  const manifest = { schema: 1, version: '2.0.4', platform: 'linux', arch: 'x64', target: 'x86_64-unknown-linux-musl', commit: 'a'.repeat(40), ...overrides };
  await writeFile(path.join(payload, 'server-package.json'), JSON.stringify(manifest));
  const archive = path.join(directory, 'server.tar.gz');
  await execute('tar', ['-C', payload, '-czf', archive, '.']);
  const stage = path.join(directory, 'stage');
  await mkdir(stage);
  return { archive, stage, payload };
}

test('local source archives are validated and recorded without fetching a release', native, async (context) => {
  const paths = await fixture(context);
  const { archive, stage } = await sourcePackage(paths);
  const bytes = await readFile(archive);
  const result = await stageSourceArchive(archive, stage);
  assert.equal(result.version, '2.0.4');
  assert.equal(result.commit, 'a'.repeat(40));
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await readFile(path.join(result.payload, '.archive-sha256'), 'utf8')).trim(), result.sha256);
  assert.deepEqual(await readFile(archive), bytes);
});

test('local archives reject unsupported targets and symlink payloads', native, async (context) => {
  const paths = await fixture(context);
  const wrong = await sourcePackage(paths, { target: 'aarch64-apple-darwin' });
  await assert.rejects(stageSourceArchive(wrong.archive, wrong.stage), /identity does not match/);
  const linked = await sourcePackage(paths);
  await rm(path.join(linked.payload, 'termloop-server'));
  await symlink('/etc/passwd', path.join(linked.payload, 'termloop-server'));
  await execute('tar', ['-C', linked.payload, '-czf', linked.archive, '.']);
  await assert.rejects(stageSourceArchive(linked.archive, linked.stage), /only regular files/);
});

test('source installs preserve stable rollback and can advance to a newer stable release', native, async (context) => {
  const paths = await fixture(context);
  const previous = await release(paths, '2.0.4');
  await symlink('releases/2.0.4', paths.current);
  await mkdir(paths.state);
  await writeFile(path.join(paths.state, 'state.v1.json'), 'user data');
  const { archive, stage } = await sourcePackage(paths);
  const source = await stageSourceArchive(archive, stage);
  const directory = path.join(paths.releases, `source-${source.commit}`);
  await rename(source.payload, directory);
  const services = { stop: async () => {}, start: async () => {}, healthy: async () => {} };
  await activateRelease(paths, { directory, version: source.version }, previous, services);
  const installed = await currentRelease(paths);
  assert.deepEqual(installed, { directory, version: '2.0.4', sourceCommit: source.commit });
  assert.equal(newerVersion('2.0.4', installed.version), false);
  assert.equal(newerVersion('2.0.5', installed.version), true);
  assert.equal(await readFile(path.join(previous.directory, 'server-package.json'), 'utf8'), JSON.stringify({ schema: 1, version: '2.0.4' }));
  const next = await release(paths, '2.0.5');
  await activateRelease(paths, next, installed, services);
  assert.deepEqual(await currentRelease(paths), next);
  assert.equal(await readFile(path.join(paths.state, 'state.v1.json'), 'utf8'), 'user data');
});

test('source directory identity must match its manifest commit', native, async (context) => {
  const paths = await fixture(context);
  const directory = path.join(paths.releases, `source-${'a'.repeat(40)}`);
  await mkdir(directory);
  await writeFile(path.join(directory, 'server-package.json'), JSON.stringify({ schema: 1, version: '2.0.4', commit: 'b'.repeat(40) }));
  await symlink(path.relative(paths.root, directory), paths.current);
  await assert.rejects(currentRelease(paths), /Invalid installed source identity/);
});

test('cleanup retains the previous source build and removes only marked managed history', native, async (context) => {
  const paths = await fixture(context);
  const previous = `source-${'a'.repeat(40)}`;
  const expired = `source-${'b'.repeat(40)}`;
  const unmarked = `source-${'c'.repeat(40)}`;
  for (const name of ['2.0.5', previous, expired, unmarked, 'user-data']) {
    const directory = path.join(paths.releases, name);
    await mkdir(directory);
    if (name !== unmarked) await writeFile(path.join(directory, '.archive-sha256'), 'fixture');
  }
  await pruneReleases(paths, new Set(['2.0.5', previous]));
  await assert.rejects(readFile(path.join(paths.releases, expired, '.archive-sha256')), { code: 'ENOENT' });
  for (const name of ['2.0.5', previous, 'user-data']) assert.equal(await readFile(path.join(paths.releases, name, '.archive-sha256'), 'utf8'), 'fixture');
  assert.ok((await stat(path.join(paths.releases, unmarked))).isDirectory());
});

test('source archives cannot change the automatic update or status action', async () => {
  for (const action of ['update', 'status']) await assert.rejects(runManager(action, undefined, undefined, '/tmp/source.tar.gz'), /only by install/);
  await assert.rejects(runManager('install', '2.0.4', undefined, '/tmp/source.tar.gz'), /without --version/);
});
