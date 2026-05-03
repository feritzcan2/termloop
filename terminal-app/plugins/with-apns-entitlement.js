const { withEntitlementsPlist, withXcodeProject } = require("expo/config-plugins");

function clean(value) {
  return typeof value === "string" ? value.replace(/^"|"$/g, "") : "";
}

function isAppBuildConfig(config, bundleIdentifier) {
  const settings = config && config.buildSettings;
  if (!settings) return false;
  return clean(settings.PRODUCT_BUNDLE_IDENTIFIER) === bundleIdentifier;
}

function setPushCapability(project) {
  const projectInfo = project.getFirstProject && project.getFirstProject();
  const targetInfo = project.getFirstTarget && project.getFirstTarget();
  const targetUuid = targetInfo && targetInfo.uuid;
  const attributes = projectInfo && projectInfo.firstProject && projectInfo.firstProject.attributes;
  if (!targetUuid || !attributes) return;

  attributes.TargetAttributes = attributes.TargetAttributes || {};
  const targetAttributes = attributes.TargetAttributes[targetUuid] || {};
  targetAttributes.SystemCapabilities = targetAttributes.SystemCapabilities || {};
  targetAttributes.SystemCapabilities["com.apple.Push"] = { enabled: 1 };
  attributes.TargetAttributes[targetUuid] = targetAttributes;
}

function setApsEnvironmentBuildSettings(project, bundleIdentifier) {
  const configurations = project.pbxXCBuildConfigurationSection();
  for (const config of Object.values(configurations)) {
    if (!isAppBuildConfig(config, bundleIdentifier)) continue;
    const name = clean(config.name);
    config.buildSettings.APS_ENVIRONMENT = name.includes("Debug")
      ? "development"
      : "production";
  }
}

module.exports = function withApnsEntitlement(config) {
  const bundleIdentifier = config.ios && config.ios.bundleIdentifier;

  config = withEntitlementsPlist(config, (next) => {
    next.modResults["aps-environment"] = "$(APS_ENVIRONMENT)";
    return next;
  });

  config = withXcodeProject(config, (next) => {
    if (bundleIdentifier) {
      setApsEnvironmentBuildSettings(next.modResults, bundleIdentifier);
    }
    setPushCapability(next.modResults);
    return next;
  });

  return config;
};
