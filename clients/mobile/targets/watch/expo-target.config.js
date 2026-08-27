/** @type {import('@bacons/apple-targets').Config} */
module.exports = {
  type: "watch",
  name: "TermLoopWatch",
  displayName: "TermLoop",
  bundleIdentifier: ".watch",
  deploymentTarget: "10.0",
  icon: "../../assets/icon.png",
  entitlements: {
    "aps-environment": "$(APS_ENVIRONMENT)",
    // Shared with the complication widget so it can read the gateway credential.
    "keychain-access-groups": ["$(AppIdentifierPrefix)ai.termloop.watch.shared"],
  },
};
