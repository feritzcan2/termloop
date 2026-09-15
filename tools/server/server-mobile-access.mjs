import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const packagedAssets = typeof __TERMLOOP_SERVER_MOBILE_ASSETS__ === 'undefined'
  ? undefined : __TERMLOOP_SERVER_MOBILE_ASSETS__;

export const mobileAssetFiles = [
  'mobile-access.mjs', 'mobile-access-installer.mjs', 'mobile-access-gateway.mjs',
  'gateway-artifact.json', 'transcriber/Transcriber.swift',
];

// Assets are embedded in the manager so older updaters can still validate the
// original, fixed archive file list. Nothing is downloaded during enrollment.
export async function serverMobileAccess(action, paths, assets = packagedAssets, run = execute) {
  if (!['pair', 'reconcile'].includes(action)) throw new Error('Unknown Mobile Access action');
  if (!assets) {
    if (action === 'reconcile') return { status: 'notIncluded' };
    return { ok: false, errorCode: 'packageMissing' };
  }
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(path.join(paths.root, '.mobile-artifact-'));
  try {
    await mkdir(path.join(stage, 'transcriber'), { mode: 0o700 });
    for (const name of mobileAssetFiles) {
      if (typeof assets[name] !== 'string') throw new Error('Incomplete Mobile Access assets');
      await writeFile(path.join(stage, name), assets[name], { mode: 0o600 });
    }
    const result = await run(process.execPath, [
      path.join(stage, 'mobile-access.mjs'), '--artifact-dir', stage,
      '--runtime', paths.runtime,
      ...(action === 'pair' ? ['--print'] : ['--reconcile', '--quiet']),
    ], {
      timeout: 60_000, maxBuffer: 32 * 1024,
      env: { ...process.env, XDG_STATE_HOME: path.dirname(paths.state) },
    });
    if (action === 'reconcile') return { status: 'reconciled' };
    const pairingCode = result.stdout.split(/\r?\n/).find((line) => line.startsWith('TLMP1:'));
    if (!pairingCode || pairingCode.length > 8 * 1024) return { ok: false, errorCode: 'pairingFailed' };
    return { ok: true, pairingCode };
  } catch (error) {
    // Child-process errors may contain pairing credentials. Only known failure
    // categories cross SSH or appear in the updater journal.
    const errorCode = mobileFailureCode(error);
    if (action === 'reconcile') throw new Error(`Mobile Access update failed (${errorCode})`);
    return { ok: false, errorCode };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export function mobileFailureCode(error) {
  const diagnostic = String(error?.stderr ?? '') + '\n' + String(error?.message ?? '');
  if (/Tailscale CLI was not found/.test(diagnostic)) return 'tailscaleMissing';
  if (/Tailscale is not connected/.test(diagnostic)) return 'tailscaleOffline';
  if (/Access denied|permission denied|must be root|use sudo|not.*operator/i.test(diagnostic)) return 'tailscalePermission';
  if (/serve.*not enabled|enable.*serve|enable.*https/i.test(diagnostic)) return 'tailscaleServe';
  if (/ENOENT.*runtime\.json|Runtime discovery|expected shared loopback/.test(diagnostic)) return 'daemonUnavailable';
  if (/ENOSPC|No space left/.test(diagnostic)) return 'diskFull';
  if (/Failed to connect to.*bus|Failed to restart|Failed to enable|systemctl/.test(diagnostic)) return 'serviceFailed';
  if (error?.killed || error?.code === 'ETIMEDOUT') return 'timedOut';
  return 'pairingFailed';
}
