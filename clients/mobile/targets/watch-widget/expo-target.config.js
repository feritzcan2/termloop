/** @type {import('@bacons/apple-targets').Config} */
module.exports = {
  type: "watch-widget",
  name: "TermLoopComplication",
  displayName: "TermLoop",
  bundleIdentifier: ".watch.widget",
  deploymentTarget: "10.0",
  entitlements: {
    "keychain-access-groups": ["$(AppIdentifierPrefix)ai.termloop.watch.shared"],
    // The phone's share inbox App Group is not the complication's business;
    // an explicit empty list stops apple-targets from copying it here.
    "com.apple.security.application-groups": [],
  },
};
