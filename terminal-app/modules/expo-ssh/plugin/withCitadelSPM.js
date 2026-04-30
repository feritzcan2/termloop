const {
  withPodfile,
  withPodfileProperties,
  withXcodeProject,
} = require('@expo/config-plugins');

const IOS_DEPLOYMENT_TARGET = '17.0';

const SPM_PACKAGES = [
  { name: 'Citadel',                    url: 'https://github.com/orlandos-nl/Citadel.git',                     version: '0.12.1', products: ['Citadel'] },
  { name: 'swift-nio-ssh',              url: 'https://github.com/Wellz26/swift-nio-ssh.git',                   version: '0.3.6',  products: ['NIOSSH'] },
  { name: 'swift-nio',                  url: 'https://github.com/apple/swift-nio.git',                         version: '2.97.1', products: ['NIO', 'NIOCore'] },
  { name: 'swift-nio-transport-services', url: 'https://github.com/apple/swift-nio-transport-services.git',    version: '1.24.0', products: ['NIOTransportServices'] },
];

const TOP_MARK = '# withCitadelSPM:top';
const POST_MARK = '# withCitadelSPM:post_install';

function buildTopBlock() {
  const lines = [TOP_MARK, "plugin 'cocoapods-spm'"];
  for (const p of SPM_PACKAGES) {
    const productsRuby = p.products.map((x) => `"${x}"`).join(', ');
    lines.push(
      `spm_pkg "${p.name}", :url => "${p.url}", :version => "${p.version}", :products => [${productsRuby}]`
    );
  }
  return lines.join('\n') + '\n';
}

const POST_INSTALL_PATCH = `    ${POST_MARK}
    # Deferred via at_exit because cocoapods-spm rewrites xcconfigs AFTER Podfile post_install.
    sandbox_root = installer.sandbox.root.to_s
    at_exit do
      xcconfigs = Dir.glob("#{sandbox_root}/Target Support Files/**/*.xcconfig")
      patched = 0
      xcconfigs.each do |xcc|
        original = File.read(xcc)
        fixed = original.gsub(
          '\${GENERATED_MODULEMAP_DIR}/CCitadelBcrypt.modulemap',
          '\${SOURCE_PACKAGES_CHECKOUTS_DIR}/Citadel/Sources/CCitadelBcrypt/include/module.modulemap'
        )
        if fixed != original
          File.write(xcc, fixed)
          patched += 1
        end
      end
      puts "[withCitadelSPM] patched #{patched} xcconfigs (CCitadelBcrypt modulemap path)"

      # Patch Citadel's SSHClient.connect(on:settings:) to hop to the channel's event loop
      # before calling SSHClientSession.addHandlers, which uses syncOperations.addHandlers
      # and must execute on the event loop thread. Without the hop the call traps with
      # EXC_BREAKPOINT (NIO precondition fail) when invoked from a Swift async Task.
      # Xcode's actual compile path is under DerivedData/*/SourcePackages/checkouts/Citadel —
      # the cocoapods-spm .spm.pods/ path is not what Xcode compiles from. We patch both to be safe.
      citadel_roots = Dir.glob("#{sandbox_root}/../.spm.pods/packages/**/checkouts/Citadel") +
                      Dir.glob(File.expand_path("~/Library/Developer/Xcode/DerivedData/*/SourcePackages/checkouts/Citadel"))
      citadel_roots.each do |croot|
        client_swift = File.join(croot, "Sources/Citadel/Client.swift")
        next unless File.exist?(client_swift)
        original = File.read(client_swift)
        needle = "        let inboundChannelHandler = SSHClientInboundChannelHandler()\\n        try await SSHClientSession.addHandlers(\\n            on: channel,\\n            inboundChannelHandler: inboundChannelHandler,\\n            settings: settings\\n        ).get()"
        replacement = "        let inboundChannelHandler = SSHClientInboundChannelHandler()\\n        try await channel.eventLoop.flatSubmit {\\n            SSHClientSession.addHandlers(\\n                on: channel,\\n                inboundChannelHandler: inboundChannelHandler,\\n                settings: settings\\n            )\\n        }.get()"
        if original.include?(needle)
          File.write(client_swift, original.sub(needle, replacement))
          puts "[withCitadelSPM] patched Citadel Client.swift at #{croot} (event-loop hop for addHandlers)"
        end
      end
    end
`;

function injectTopBlock(contents) {
  if (contents.includes(TOP_MARK)) return contents;
  const anchor = "require File.join(File.dirname(`node --print \"require.resolve('react-native/package.json')\"`), \"scripts/react_native_pods\")";
  const idx = contents.indexOf(anchor);
  const block = '\n' + buildTopBlock();
  if (idx === -1) return block + contents;
  const insertAt = idx + anchor.length;
  return contents.slice(0, insertAt) + '\n' + block + contents.slice(insertAt);
}

function injectPostInstall(contents) {
  if (contents.includes(POST_MARK)) return contents;
  const anchor = 'post_install do |installer|';
  const idx = contents.indexOf(anchor);
  if (idx === -1) return contents;
  const insertAt = idx + anchor.length;
  return contents.slice(0, insertAt) + '\n' + POST_INSTALL_PATCH + contents.slice(insertAt);
}

const withCitadelSPM = (config) => {
  config = withPodfileProperties(config, (cfg) => {
    cfg.modResults['ios.deploymentTarget'] = IOS_DEPLOYMENT_TARGET;
    return cfg;
  });

  config = withPodfile(config, (cfg) => {
    let c = cfg.modResults.contents;
    c = injectTopBlock(c);
    c = injectPostInstall(c);
    cfg.modResults.contents = c;
    return cfg;
  });

  config = withXcodeProject(config, (cfg) => {
    const proj = cfg.modResults;
    const configurations = proj.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(configurations)) {
      const entry = configurations[key];
      if (!entry || typeof entry !== 'object' || !entry.buildSettings) continue;
      if (entry.buildSettings.IPHONEOS_DEPLOYMENT_TARGET !== undefined) {
        entry.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = IOS_DEPLOYMENT_TARGET;
      }
    }
    return cfg;
  });

  return config;
};

module.exports = withCitadelSPM;
