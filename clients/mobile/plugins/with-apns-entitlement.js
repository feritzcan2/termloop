const { withEntitlementsPlist, withXcodeProject } = require("expo/config-plugins");

function clean(value) {
  return typeof value === "string" ? value.replace(/^"|"$/g, "") : "";
}

module.exports = function withApnsEntitlement(config) {
  const bundleIdentifier = config.ios && config.ios.bundleIdentifier;
  config = withEntitlementsPlist(config, (next) => {
    next.modResults["aps-environment"] = "$(APS_ENVIRONMENT)";
    return next;
  });
  return withXcodeProject(config, (next) => {
    const project = next.modResults;
    const projectInfo = project.getFirstProject && project.getFirstProject();
    const targetInfo = project.getFirstTarget && project.getFirstTarget();
    const targetUuid = targetInfo && targetInfo.uuid;
    const attributes = projectInfo?.firstProject?.attributes;
    if (targetUuid && attributes) {
      attributes.TargetAttributes ||= {};
      const target = attributes.TargetAttributes[targetUuid] || {};
      target.SystemCapabilities ||= {};
      target.SystemCapabilities["com.apple.Push"] = { enabled: 1 };
      attributes.TargetAttributes[targetUuid] = target;
    }
    for (const buildConfig of Object.values(project.pbxXCBuildConfigurationSection())) {
      const settings = buildConfig?.buildSettings;
      if (!settings || clean(settings.PRODUCT_BUNDLE_IDENTIFIER) !== bundleIdentifier) continue;
      settings.APS_ENVIRONMENT = clean(buildConfig.name).includes("Debug") ? "development" : "production";
    }
    return next;
  });
};
