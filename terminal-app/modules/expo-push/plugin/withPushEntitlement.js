const { withEntitlementsPlist, withInfoPlist } = require('@expo/config-plugins');

const withPushEntitlement = (config, options = {}) => {
  const mode = options.mode === 'production' ? 'production' : 'development';

  config = withEntitlementsPlist(config, (cfg) => {
    cfg.modResults['aps-environment'] = mode;
    return cfg;
  });

  config = withInfoPlist(config, (cfg) => {
    const modes = cfg.modResults.UIBackgroundModes || [];
    if (!modes.includes('remote-notification')) {
      modes.push('remote-notification');
    }
    cfg.modResults.UIBackgroundModes = modes;
    return cfg;
  });

  return config;
};

module.exports = withPushEntitlement;
