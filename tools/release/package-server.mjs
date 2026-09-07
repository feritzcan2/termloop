import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [binaries, cli, output] = process.argv.slice(2);
if (!binaries || !cli || !output) throw new Error('Usage: package-server.mjs <musl-binary-directory> <bundled-cli> <output-directory>');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
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
  for (const name of ['install.sh', 'termloop-server-manager.mjs', 'server-release.mjs']) {
    await copyFile(path.join(root, 'tools/server', name), path.join(stage, name));
  }
  await chmod(path.join(stage, 'install.sh'), 0o755);
  await writeFile(path.join(stage, 'server-package.json'), JSON.stringify({
    schema: 1, version, platform: 'linux', arch: 'x64', target: 'x86_64-unknown-linux-musl', commit: stdout.trim(),
  }, null, 2) + '\n');
  await mkdir(output, { recursive: true });
  const archive = path.resolve(output, `termloop-server-linux-x64-${version}.tar.gz`);
  await execute('tar', ['-C', stage, '-czf', archive, '.']);
  console.log(archive);
} finally { await rm(stage, { recursive: true, force: true }); }
