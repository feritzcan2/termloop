import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const sourceFile = path.join(scriptsDir, "transcriber", "Transcriber.swift");

const bundleName = "TermLoopTranscriber.app";
const executableName = "TermLoopTranscriber";

// Speech recognition is a TCC permission, and TCC grants it to a signed bundle
// identity rather than a bare executable path. The tool is therefore built into
// a minimal ad-hoc signed .app whose Info.plist carries the usage description.
const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>ai.termloop.transcriber</string>
  <key>CFBundleName</key><string>TermLoop Transcriber</string>
  <key>CFBundleExecutable</key><string>${executableName}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSBackgroundOnly</key><true/>
  <key>NSSpeechRecognitionUsageDescription</key><string>TermLoop, saatten dikte ettigin sesi yaziya cevirir.</string>
</dict>
</plist>
`;

export const voiceUploadLimitBytes = 2 * 1024 * 1024;

const allowedAudioTypes = new Set(["audio/m4a", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/x-wav"]);

export function validVoiceUpload(contentType, byteLength) {
  const type = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  return allowedAudioTypes.has(type) && byteLength > 0 && byteLength <= voiceUploadLimitBytes;
}

/// Reports only the file container, never recorded content. This keeps failed
/// device uploads diagnosable without retaining or logging the user's speech.
export function voiceContainerOf(audio) {
  const bytes = Buffer.isBuffer(audio) ? audio : Buffer.from(audio ?? []);
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WAVE") return "wav";
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") return "isobmff";
  if (bytes.length >= 4
    && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
  return "unknown";
}

export function transcriptionOf(stdout) {
  const parsed = JSON.parse(String(stdout));
  const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";
  return { text, onDevice: parsed?.onDevice === true };
}

function runTool(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve(stdout);
    });
  });
}

async function newerThanSource(file) {
  try {
    const [built, source] = await Promise.all([stat(file), stat(sourceFile)]);
    return built.mtimeMs >= source.mtimeMs;
  } catch {
    return false;
  }
}

// Built once per machine into the gateway's runtime directory and reused; the
// rebuild only happens when the Swift source is newer than the binary.
export async function ensureTranscriber(cacheDir) {
  const override = process.env.TERMLOOP_TRANSCRIBER_BIN;
  if (override !== undefined && override.length > 0) return override;
  const bundle = path.join(cacheDir, bundleName);
  const executable = path.join(bundle, "Contents", "MacOS", executableName);
  if (await newerThanSource(executable)) return executable;
  await mkdir(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  await writeFile(path.join(bundle, "Contents", "Info.plist"), infoPlist);
  await runTool("swiftc", ["-O", sourceFile, "-o", executable]);
  await runTool("codesign", ["--force", "--sign", "-", bundle]);
  return executable;
}

export async function transcribeAudioFile(cacheDir, audioFile, locale = "tr-TR") {
  const executable = await ensureTranscriber(cacheDir);
  const args = [audioFile, locale];
  if (/\.[cm]?js$/i.test(executable)) {
    return transcriptionOf(await runTool(process.execPath, [executable, ...args]));
  }
  return transcriptionOf(await runTool(executable, args));
}
