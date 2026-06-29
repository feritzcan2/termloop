const fs = require("fs");
const path = require("path");
const { withDangerousMod, withXcodeProject } = require("expo/config-plugins");

const SOURCES = [
  "StartTermLoopVoiceAgentIntent.swift",
  "TermLoopVoiceAgentConfig.swift",
  "TermLoopVoiceAgentConfigBridge.m",
  "TermLoopVoiceDictation.swift",
];

function findIosAppDir(projectRoot) {
  const iosRoot = path.join(projectRoot, "ios");
  const entries = fs.existsSync(iosRoot) ? fs.readdirSync(iosRoot) : [];
  const match = entries.find((entry) =>
    fs.existsSync(path.join(iosRoot, entry, "AppDelegate.swift"))
  );
  if (!match) {
    throw new Error("Could not find iOS app directory containing AppDelegate.swift");
  }
  return match;
}

function findAppGroup(project) {
  const groups = project.hash.project.objects.PBXGroup || {};
  for (const [key, group] of Object.entries(groups)) {
    if (key.endsWith("_comment")) continue;
    const children = group.children || [];
    if (children.some((child) => child.comment === "AppDelegate.swift")) {
      return key;
    }
  }
  const fallback = project.findPBXGroupKey({ name: "TermLoopMobile" });
  if (!fallback) {
    throw new Error("Could not find Xcode app group for voice agent sources");
  }
  return fallback;
}

function ensureSource(project, filename) {
  const target = project.getFirstTarget().uuid;
  const group = findAppGroup(project);
  const groupInfo = project.getPBXGroupByKey(group);
  const appDir = groupInfo?.path || groupInfo?.name;
  if (!appDir) {
    throw new Error("Could not resolve Xcode app source path for voice agent sources");
  }
  const filePath = `${appDir}/${filename}`;
  if (project.hasFile(filePath)) return;
  project.addSourceFile(filePath, { target }, group);
}

function ensureBridgingHeader(projectRoot) {
  const appDir = findIosAppDir(projectRoot);
  const headerPath = path.join(
    projectRoot,
    "ios",
    appDir,
    "TermLoopMobile-Bridging-Header.h"
  );
  // Expo's generated project already points SWIFT_OBJC_BRIDGING_HEADER at
  // this app header; this plugin only keeps the React bridge import present.
  const importLine = "#import <React/RCTBridgeModule.h>";
  let contents = fs.existsSync(headerPath)
    ? fs.readFileSync(headerPath, "utf8")
    : "";
  if (!contents.includes(importLine)) {
    contents = `${contents.trimEnd()}\n${importLine}\n`;
    fs.writeFileSync(headerPath, contents);
  }
}

function copySources(projectRoot) {
  const appDir = findIosAppDir(projectRoot);
  const srcDir = path.join(__dirname, "voice-agent-ios");
  const dstDir = path.join(projectRoot, "ios", appDir);
  fs.mkdirSync(dstDir, { recursive: true });
  for (const filename of SOURCES) {
    fs.copyFileSync(path.join(srcDir, filename), path.join(dstDir, filename));
  }
}

module.exports = function withVoiceAgentIntent(config) {
  config = withDangerousMod(config, [
    "ios",
    async (next) => {
      copySources(next.modRequest.projectRoot);
      ensureBridgingHeader(next.modRequest.projectRoot);
      return next;
    },
  ]);

  config = withXcodeProject(config, (next) => {
    for (const filename of SOURCES) {
      ensureSource(next.modResults, filename);
    }
    return next;
  });

  return config;
};
