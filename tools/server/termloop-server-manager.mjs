#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, statfs, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { newerVersion, parseVersion, resolveRelease, stageRelease } from './server-release.mjs';

const execute = promisify(execFile);
const serverUnit = 'termloop-next.service';
const updateUnit = 'termloop-next-update.service';
const timerUnit = 'termloop-next-update.timer';

export function installationPaths(env = process.env, home = os.homedir(), uid = process.getuid?.()) {
  const root = path.join(env.XDG_DATA_HOME || path.join(home, '.local/share'), 'termloop-server');
  return {
    root,
    current: path.join(root, 'current'),
    releases: path.join(root, 'releases'),
    units: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd/user'),
    state: path.join(env.XDG_STATE_HOME || path.join(home, '.local/state'), 'termloop-next'),
    runtime: path.join(env.XDG_RUNTIME_DIR || `/run/user/${uid}`, 'termloop-next/runtime.json'),
  };
}

function quote(value, command = false) {
  if (!value || /[\r\n\0]/.test(value)) throw new Error('Invalid service path');
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  return '"' + (command ? escaped.replaceAll('$', () => '$$') : escaped) + '"';
}

export function serviceDefinitions(paths, node = process.execPath, env = process.env) {
  const searchPath = `${paths.current}:${env.PATH || '/usr/local/bin:/usr/bin:/bin'}`;
  return {
    [serverUnit]: `[Unit]\nDescription=TermLoop server\nAfter=default.target\n\n[Service]\nType=simple\nExecStart=${quote(path.join(paths.current, 'termloop-server'), true)}\nEnvironment=${quote('PATH=' + searchPath)}\nEnvironment=${quote('TERMLOOP_STATE_DIR=' + paths.state)}\nEnvironment=${quote('TERMLOOP_RUNTIME_DIR=' + path.dirname(paths.runtime))}\nRestart=on-failure\nRestartSec=2\nKillMode=mixed\nTimeoutStopSec=180\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`,
    [updateUnit]: `[Unit]\nDescription=Update TermLoop server from stable GitHub releases\nAfter=network-online.target\n\n[Service]\nType=oneshot\nExecStart=${quote(node, true)} ${quote(path.join(paths.current, 'termloop-server-manager.mjs'), true)} update\nEnvironment=${quote('PATH=' + searchPath)}\nEnvironment=${quote('XDG_DATA_HOME=' + path.dirname(paths.root))}\nEnvironment=${quote('XDG_STATE_HOME=' + path.dirname(paths.state))}\nEnvironment=${quote('XDG_RUNTIME_DIR=' + path.dirname(path.dirname(paths.runtime)))}\nEnvironment=${quote('XDG_CONFIG_HOME=' + path.dirname(path.dirname(paths.units)))}\nTimeoutStartSec=15min\nUMask=0077\n`,
    [timerUnit]: '[Unit]\nDescription=Check for TermLoop server updates hourly\n\n[Timer]\nOnCalendar=hourly\nRandomizedDelaySec=10min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n',
  };
}

async function exists(target) {
  try { await lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function atomicFile(target, contents) {
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, target);
}

async function switchRelease(paths, directory) {
  const temporary = `${paths.current}.tmp-${process.pid}`;
  await symlink(path.relative(paths.root, directory), temporary);
  try { await rename(temporary, paths.current); } finally { await rm(temporary, { force: true }); }
}

export async function currentRelease(paths) {
  if (!await exists(paths.current)) return undefined;
  if (!(await lstat(paths.current)).isSymbolicLink()) throw new Error('Managed current release must be a symbolic link');
  const directory = path.resolve(paths.root, await readlink(paths.current));
  if (path.dirname(directory) !== paths.releases) throw new Error('Current release points outside the managed releases directory');
  const version = path.basename(directory);
  parseVersion(version);
  const manifest = JSON.parse(await readFile(path.join(directory, 'server-package.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.version !== version) throw new Error('Invalid installed release identity');
  return { version, directory };
}

function systemd(args) {
  return execute('systemctl', ['--user', ...args], { timeout: 240_000, maxBuffer: 32 * 1024 });
}

async function isActive(unit) {
  try { return (await systemd(['is-active', unit])).stdout.trim() === 'active'; } catch { return false; }
}

async function waitHealthy(paths, version) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await systemd(['show', serverUnit, '--property=MainPID', '--value'])).stdout.trim());
      const discovery = JSON.parse(await readFile(paths.runtime, 'utf8'));
      if (pid > 0 && discovery.pid === pid && await isActive(serverUnit)) {
        const result = await execute(process.execPath, [path.join(paths.current, 'termloopctl'), 'version', '--json', '--runtime', paths.runtime], {
          timeout: 5000, maxBuffer: 32 * 1024,
        });
        if (JSON.parse(result.stdout).version === version) return;
      }
    } catch { /* The server may still be publishing fresh discovery. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`TermLoop ${version} did not become healthy within 45 seconds`);
}

async function treeSize(directory) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory()) return metadata.size;
  let total = 0;
  for (const entry of await readdir(directory)) total += await treeSize(path.join(directory, entry));
  return total;
}

async function snapshotState(paths) {
  const snapshot = path.join(paths.root, 'state-before-update');
  if (await exists(paths.state)) {
    if ((await lstat(paths.state)).isSymbolicLink()) throw new Error('Refusing to snapshot a symbolic state directory');
    const size = await treeSize(paths.state);
    const space = await statfs(paths.root);
    if (space.bavail * space.bsize < size * 2 + 512 * 1024 * 1024) throw new Error('Not enough free space for a safe state snapshot');
    const temporary = await mkdtemp(path.join(paths.root, '.snapshot-'));
    try {
      await cp(paths.state, path.join(temporary, 'state'), { recursive: true, dereference: false, preserveTimestamps: true });
      await rm(snapshot, { recursive: true, force: true });
      await rename(path.join(temporary, 'state'), snapshot);
    } finally { await rm(temporary, { recursive: true, force: true }); }
    return snapshot;
  }
  return undefined;
}

async function restoreState(paths, snapshot) {
  if (!snapshot) return;
  const temporary = await mkdtemp(path.join(path.dirname(paths.state), '.termloop-restore-'));
  try {
    await cp(snapshot, path.join(temporary, 'restored'), { recursive: true, dereference: false, preserveTimestamps: true });
    if (await exists(paths.state)) await rename(paths.state, path.join(temporary, 'failed'));
    try { await rename(path.join(temporary, 'restored'), paths.state); }
    catch (error) {
      if (await exists(path.join(temporary, 'failed'))) await rename(path.join(temporary, 'failed'), paths.state);
      throw error;
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

// The complete stopped-state transaction is independently exercised with fake services.
export async function activateRelease(paths, next, previous, service = { stop: () => systemd(['stop', serverUnit]), start: () => systemd(['start', serverUnit]), healthy: (version) => waitHealthy(paths, version) }) {
  await service.stop();
  let snapshot;
  let switched = false;
  try {
    snapshot = await snapshotState(paths);
    await switchRelease(paths, next.directory);
    switched = true;
    await service.start();
    await service.healthy(next.version);
  } catch (error) {
    if (switched) await service.stop();
    if (previous) {
      if (switched) {
        await restoreState(paths, snapshot);
        await switchRelease(paths, previous.directory);
      }
      await service.start();
      await service.healthy(previous.version);
      throw new Error(`Update failed; restored TermLoop ${previous.version} and its state: ${error.message}`, { cause: error });
    }
    if (switched) await rm(paths.current);
    throw error;
  }
}

async function pruneReleases(paths, keep) {
  for (const name of await readdir(paths.releases)) {
    if (keep.has(name) || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(name)) continue;
    const directory = path.join(paths.releases, name);
    if (!(await lstat(directory)).isDirectory() || !await exists(path.join(directory, '.archive-sha256'))) continue;
    await rm(directory, { recursive: true });
  }
}

export async function runManager(action, version, paths = installationPaths()) {
  const previous = await currentRelease(paths);
  if (action === 'status') {
    return { installed: !!previous, version: previous?.version, running: await isActive(serverUnit), autoUpdate: await isActive(timerUnit), installDirectory: paths.root, stateDirectory: paths.state };
  }
  if (action === 'update' && !previous) throw new Error('Install the managed TermLoop server first');
  const linger = await execute('loginctl', ['show-user', String(process.getuid()), '--property=Linger', '--value'], { timeout: 5000 });
  if (linger.stdout.trim() !== 'yes') throw new Error(`Enable background services first: sudo loginctl enable-linger ${os.userInfo().username}`);
  if (action === 'update' && !await isActive(serverUnit)) return { updated: false, reason: 'Server is stopped; automatic updates preserve that choice', version: previous.version };
  if (!previous && await exists(path.join(paths.units, serverUnit))) throw new Error('An unmanaged TermLoop service already exists; refusing to replace it');
  const release = await resolveRelease(version);
  if (previous && !newerVersion(release.version, previous.version)) return { updated: false, version: previous.version, reason: 'Already up to date; downgrades are not automatic' };
  await mkdir(paths.releases, { recursive: true, mode: 0o700 });
  await mkdir(paths.units, { recursive: true, mode: 0o700 });
  // The process lock excludes live downloads and snapshots from another update.
  for (const name of await readdir(paths.root)) {
    if (/^\.(download|snapshot)-[A-Za-z0-9]+$/.test(name)) await rm(path.join(paths.root, name), { recursive: true, force: true });
  }
  const space = await statfs(paths.root);
  if (space.bavail * space.bsize < 1024 * 1024 * 1024) throw new Error('At least 1 GiB free is required to download and unpack a server update');
  const stage = await mkdtemp(path.join(paths.root, '.download-'));
  const directory = path.join(paths.releases, release.version);
  try {
    const payload = await stageRelease(release, stage);
    if (await exists(directory)) {
      const recorded = (await readFile(path.join(directory, '.archive-sha256'), 'utf8')).trim();
      if (recorded !== release.sha256) throw new Error('An existing version directory has a different archive identity');
    } else {
      await rename(payload, directory);
    }
    if (!previous) {
      for (const [unit, content] of Object.entries(serviceDefinitions(paths))) await atomicFile(path.join(paths.units, unit), content);
      await systemd(['daemon-reload']);
    }
    try {
      await activateRelease(paths, { directory, version: release.version }, previous);
    } catch (error) {
      if (!previous) {
        for (const unit of [serverUnit, updateUnit, timerUnit]) await rm(path.join(paths.units, unit), { force: true });
        await systemd(['daemon-reload']);
      }
      throw error;
    }
    await systemd(['enable', serverUnit]);
    await systemd(['enable', '--now', timerUnit]);
    await pruneReleases(paths, new Set([release.version, previous?.version].filter(Boolean)));
    await atomicFile(path.join(paths.root, 'last-update.json'), JSON.stringify({ version: release.version, previousVersion: previous?.version, updatedAt: new Date().toISOString() }) + '\n');
    return { updated: true, version: release.version, previousVersion: previous?.version, autoUpdate: true };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Managed server installation currently supports Linux x64');
  if (process.getuid?.() === 0) throw new Error('Run the server installer as the user who will own the server, without sudo');
  const [action = 'install', ...args] = process.argv.slice(2);
  if (!['install', 'update', 'status'].includes(action)) throw new Error('Usage: install.sh [install|update|status] [--version=X.Y.Z]');
  const versionArg = args.find((arg) => arg.startsWith('--version='));
  if (args.some((arg) => arg !== '--locked' && arg !== versionArg)) throw new Error('Unknown server installer option');
  const version = versionArg?.slice('--version='.length);
  if (version !== undefined) parseVersion(version);
  const paths = installationPaths();
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  if (action !== 'status' && !args.includes('--locked')) {
    try {
      const result = await execute('flock', ['--nonblock', path.join(paths.root, 'update.lock'), process.execPath, fileURLToPath(import.meta.url), action, ...args, '--locked'], { timeout: 15 * 60_000, maxBuffer: 64 * 1024 });
      process.stdout.write(result.stdout);
    } catch (error) { throw new Error(error.stderr?.trim() || 'Another server update is running or the update failed'); }
    return;
  }
  console.log(JSON.stringify(await runManager(action, version, paths)));
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
