const { withEntitlementsPlist, withXcodeProject } = require("expo/config-plugins");

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

function resolveApsEnvironment() {
  const value = process.env.TERMLOOP_MOBILE_APS_ENVIRONMENT || "";
  if (value === "development" || value === "production") {
    return value;
  }

  if (process.argv.join(" ").includes("run:ios")) {
    return "development";
  }

  return "production";
}

module.exports = function withApnsEntitlement(config) {
  const apsEnvironment = resolveApsEnvironment();

  config = withEntitlementsPlist(config, (next) => {
    next.modResults["aps-environment"] = apsEnvironment;
    return next;
  });

  config = withXcodeProject(config, (next) => {
    setPushCapability(next.modResults);
    return next;
  });

  return config;
};
