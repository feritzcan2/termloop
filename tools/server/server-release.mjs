import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = 'feritzcan2/termloop';
export const packageFiles = [
  'termloop-server', 'termloop-companion', 'skills-manager-cli', 'skills-manager-LICENSE',
  'termloopctl', 'termloop-server-manager.mjs', 'server-release.mjs', 'install.sh', 'server-package.json',
];
const maxArchiveBytes = 256 * 1024 * 1024;

export function parseVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Expected a stable release version such as 2.0.1');
  }
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Release version exceeds the supported range');
  return parts;
}

export function newerVersion(candidate, installed) {
  const next = parseVersion(candidate);
  const current = parseVersion(installed);
  for (let i = 0; i < 3; i++) {
    if (next[i] !== current[i]) return next[i] > current[i];
  }
  return false;
}

async function download(url, limit, request) {
  const response = await request(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'TermLoop-Server-Updater' },
    signal: AbortSignal.timeout(120_000),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`Release download failed (HTTP ${response.status})`);
  if (!response.body) throw new Error('Release download returned no body');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('Release download exceeded its size limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function resolveRelease(version, request = fetch) {
  if (version !== undefined) parseVersion(version);
  const endpoint = version ? `tags/v${version}` : 'latest';
  const metadata = JSON.parse((await download(`https://api.github.com/repos/${repository}/releases/${endpoint}`, 2 * 1024 * 1024, request)).toString());
  if (metadata.draft || metadata.prerelease || typeof metadata.tag_name !== 'string' || !metadata.tag_name.startsWith('v')) {
    throw new Error('The update source is not a published stable release');
  }
  const resolvedVersion = metadata.tag_name.slice(1);
  parseVersion(resolvedVersion);
  if (version && resolvedVersion !== version) throw new Error('Release tag does not match the requested version');
  const archive = `termloop-server-linux-x64-${resolvedVersion}.tar.gz`;
  const base = `https://github.com/${repository}/releases/download/v${resolvedVersion}/`;
  for (const name of [archive, 'SHA256SUMS']) {
    const asset = metadata.assets?.find((item) => item.name === name);
    if (!asset || asset.browser_download_url !== base + name) throw new Error(`Release is missing the supported server asset: ${name}`);
  }
  const sums = (await download(base + 'SHA256SUMS', 128 * 1024, request)).toString();
  const entries = sums.split('\n').filter((line) => line.trim()).map((line) => line.match(/^([a-f0-9]{64})\s+\*?([^\s]+)$/));
  const matches = entries.filter((entry) => entry?.[2] === archive);
  if (matches.length !== 1) throw new Error('Expected exactly one server archive checksum');
  return { version: resolvedVersion, archive, url: base + archive, sha256: matches[0][1] };
}

export function validateArchiveListing(names, verbose) {
  const expected = new Set(packageFiles);
  for (const entry of names.trim().split('\n')) {
    if (entry === './') continue;
    const name = entry.replace(/^\.\//, '');
    if (!expected.delete(name)) throw new Error(`Unexpected or duplicate server archive entry: ${entry}`);
  }
  if (expected.size) throw new Error(`Incomplete server archive: ${[...expected].join(', ')}`);
  for (const line of verbose.trim().split('\n')) {
    if (line[0] === 'd' && /\s\.\/$/.test(line)) continue;
    if (line[0] !== '-') throw new Error('Server archives must contain only regular files');
  }
}

export async function stageRelease(release, stage, request = fetch) {
  const archive = join(stage, 'download.tar.gz');
  await writeFile(archive, await download(release.url, maxArchiveBytes, request), { mode: 0o600 });
  return (await unpackArchive(archive, stage, release)).payload;
}

export async function stageSourceArchive(source, stage) {
  const metadata = await stat(source);
  if (!metadata.isFile() || metadata.size > maxArchiveBytes) throw new Error('Source archive must be a file smaller than 256 MiB');
  const archive = join(stage, 'download.tar.gz');
  await copyFile(source, archive);
  await chmod(archive, 0o600);
  if ((await stat(archive)).size > maxArchiveBytes) throw new Error('Source archive exceeds its size limit');
  return unpackArchive(archive, stage);
}

async function unpackArchive(archive, stage, expected) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  if (expected && sha256 !== expected.sha256) throw new Error('Server archive checksum mismatch');
  const options = { timeout: 60_000, maxBuffer: 128 * 1024 };
  const names = await execute('tar', ['-tzf', archive], options);
  const verbose = await execute('tar', ['-tvzf', archive], options);
  validateArchiveListing(names.stdout, verbose.stdout);
  const payload = join(stage, 'payload');
  await mkdir(payload, { mode: 0o700 });
  await execute('tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', payload], options);
  let size = 0;
  for (const name of packageFiles) {
    const entry = await stat(join(payload, name));
    if (!entry.isFile()) throw new Error('Server package contains a non-file entry');
    size += entry.size;
    await chmod(join(payload, name), name.endsWith('.json') || name.endsWith('.mjs') || name.endsWith('LICENSE') ? 0o600 : 0o700);
  }
  if (size > 512 * 1024 * 1024) throw new Error('Unpacked server package exceeds its size limit');
  const manifest = JSON.parse(await readFile(join(payload, 'server-package.json'), 'utf8'));
  parseVersion(manifest.version);
  if (manifest.schema !== 1 || (expected && manifest.version !== expected.version) || manifest.platform !== 'linux' || manifest.arch !== 'x64'
    || manifest.target !== 'x86_64-unknown-linux-musl' || !/^[a-f0-9]{40}$/.test(manifest.commit)) {
    throw new Error('Server package identity does not match the requested Linux release');
  }
  await writeFile(join(payload, '.archive-sha256'), sha256 + '\n', { mode: 0o600 });
  return { payload, version: manifest.version, commit: manifest.commit, sha256 };
}
