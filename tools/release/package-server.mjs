import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildGatewayArtifact, defaultArtifactMetadata } from '../../clients/mobile/scripts/mobile-access-installer.mjs';
import { mobileAssetFiles } from '../server/server-mobile-access.mjs';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [binaries, cli, output] = process.argv.slice(2);
if (!binaries || !cli || !output) throw new Error('Usage: package-server.mjs <musl-binary-directory> <bundled-cli> <output-directory>');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const generatedContract = await readFile(path.join(root, 'contract/generated/typescript/src/current.ts'), 'utf8');
const protocolVersion = generatedContract.match(/^export const CONTRACT_IDENTITY = "(sha256:[a-f0-9]{64})"/m)?.[1];
if (!protocolVersion) throw new Error('Generated server protocol identity is missing; run codegen first');
const { stdout } = await execute('git', ['rev-parse', 'HEAD'], { cwd: root });
const stage = await mkdtemp(path.join(os.tmpdir(), 'termloop-server-package-'));
try {
  for (const name of ['termloop-server', 'termloop-companion', 'skills-manager-cli']) {
    await copyFile(path.join(binaries, name), path.join(stage, name));
    await chmod(path.join(stage, name), 0o755);
  }
  await copyFile(cli, path.join(stage, 'termloopctl'));
  await chmod(path.join(stage, 'termloopctl'), 0o755);
  await copyFile(path.join(root, 'tools/skills-manager/LICENSE'), path.join(stage, 'skills-manager-LICENSE'));
  for (const name of ['install.sh', 'server-release.mjs']) {
    await copyFile(path.join(root, 'tools/server', name), path.join(stage, name));
  }
  const mobileStage = await mkdtemp(path.join(os.tmpdir(), 'termloop-server-mobile-'));
  try {
    const scriptsDirectory = path.join(root, 'clients/mobile/scripts');
    const [major, minor, patch] = version.split('.').map(Number);
    await buildGatewayArtifact({ scriptsDirectory, artifactDirectory: mobileStage, metadata: defaultArtifactMetadata({
      releaseVersion: version, channel: 'production', owner: 'ai.termloop.server',
      sequence: major * 1_000_000 + minor * 1_000 + patch,
    }) });
    for (const name of ['mobile-access.mjs', 'mobile-access-installer.mjs']) {
      await copyFile(path.join(scriptsDirectory, name), path.join(mobileStage, name));
    }
    const assets = Object.fromEntries(await Promise.all(mobileAssetFiles.map(async (name) => [name, await readFile(path.join(mobileStage, name), 'utf8')])));
    const { build } = createRequire(path.join(root, 'clients/mobile/package.json'))('esbuild');
    await build({
      entryPoints: [path.join(root, 'tools/server/termloop-server-manager.mjs')],
      outfile: path.join(stage, 'termloop-server-manager.mjs'),
      bundle: true, platform: 'node', format: 'esm', target: 'node22',
      external: ['./server-release.mjs'],
      define: { __TERMLOOP_SERVER_MOBILE_ASSETS__: JSON.stringify(assets) },
    });
  } finally { await rm(mobileStage, { recursive: true, force: true }); }
  await chmod(path.join(stage, 'install.sh'), 0o755);
  await writeFile(path.join(stage, 'server-package.json'), JSON.stringify({
    schema: 1, version, protocolVersion, mobileAccess: 1, platform: 'linux', arch: 'x64', target: 'x86_64-unknown-linux-musl', commit: stdout.trim(),
  }, null, 2) + '\n');
  await mkdir(output, { recursive: true });
  const archive = path.resolve(output, `termloop-server-linux-x64-${version}.tar.gz`);
  await execute('tar', ['-C', stage, '-czf', archive, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  console.log(archive);
} finally { await rm(stage, { recursive: true, force: true }); }
