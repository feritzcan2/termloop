// Store-compliance settings the generated watch target cannot express in
// expo-target.config.js:
// - PRODUCT_NAME: the Xcode target name (TermLoopWatch) leaks into the iOS
//   Watch app's install UI, so ship the user-facing app name instead.
// - MARKETING_VERSION / CURRENT_PROJECT_VERSION: App Store validation requires
//   the embedded watch app to match the iPhone app's version and build.
// - APS_ENVIRONMENT: the entitlement value ($(APS_ENVIRONMENT)) resolves to
//   development for Debug and production for Release, mirroring the phone
//   target's with-apns-entitlement behavior. Local device builds override it
//   on the xcodebuild command line.
// Uses the same @bacons/xcode model as the target generator; must be listed
// BEFORE @bacons/apple-targets in app.json so it runs after target creation
// (the provider must be the last mod registered).
const { withXcodeProjectBeta } = require("@bacons/apple-targets/build/with-bacons-xcode");

const WATCH_BUNDLE_IDENTIFIER = "ai.termloop.mobile.watch";
const WATCH_WIDGET_BUNDLE_IDENTIFIER = "ai.termloop.mobile.watch.widget";

module.exports = function withWatchTargetSettings(config) {
  const marketingVersion = config.version;
  const buildNumber = config.ios && config.ios.buildNumber;
  return withXcodeProjectBeta(config, (next) => {
    const project = next.modResults;
    for (const target of project.rootObject.props.targets) {
      const configurations = target.props.buildConfigurationList?.props.buildConfigurations ?? [];
      for (const buildConfiguration of configurations) {
        const settings = buildConfiguration.props.buildSettings;
        const bundle = settings?.PRODUCT_BUNDLE_IDENTIFIER;
        if (bundle !== WATCH_BUNDLE_IDENTIFIER && bundle !== WATCH_WIDGET_BUNDLE_IDENTIFIER) continue;
        if (marketingVersion) settings.MARKETING_VERSION = marketingVersion;
        if (buildNumber) settings.CURRENT_PROJECT_VERSION = buildNumber;
        if (bundle !== WATCH_BUNDLE_IDENTIFIER) continue;
        settings.PRODUCT_NAME = "TermLoop";
        settings.APS_ENVIRONMENT = buildConfiguration.props.name.includes("Debug")
          ? "development"
          : "production";
      }
    }
    return next;
  });
};
