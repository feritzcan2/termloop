/** @type {import('@bacons/apple-targets').Config} */
module.exports = {
  type: "share",
  name: "TermLoopShare",
  displayName: "TermLoop",
  bundleIdentifier: ".share",
  deploymentTarget: "16.4",
  frameworks: ["UniformTypeIdentifiers"],
  entitlements: {
    "com.apple.security.application-groups": ["group.ai.termloop.mobile"],
  },
};
