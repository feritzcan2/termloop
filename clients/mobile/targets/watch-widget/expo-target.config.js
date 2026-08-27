/** @type {import('@bacons/apple-targets').Config} */
module.exports = {
  type: "watch-widget",
  name: "TermLoopComplication",
  displayName: "TermLoop",
  bundleIdentifier: ".watch.widget",
  deploymentTarget: "10.0",
  entitlements: {
    "keychain-access-groups": ["$(AppIdentifierPrefix)ai.termloop.watch.shared"],
  },
};
