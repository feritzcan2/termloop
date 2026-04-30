Pod::Spec.new do |s|
  s.name           = 'ExpoSsh'
  s.version        = '1.0.0'
  s.summary        = 'SSH module for Expo'
  s.description    = 'Native SSH module wrapping NMSSH for terminal shell access'
  s.author         = 'dev'
  s.homepage       = 'https://github.com/example'
  s.license        = 'MIT'
  s.platforms      = { :ios => '17.0' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'
  s.spm_dependency 'Citadel/Citadel'
  s.spm_dependency 'swift-nio-ssh/NIOSSH'
  s.spm_dependency 'swift-nio/NIO'
  s.spm_dependency 'swift-nio/NIOCore'
  s.spm_dependency 'swift-nio-transport-services/NIOTransportServices'

  s.source_files = '**/*.swift'
end
