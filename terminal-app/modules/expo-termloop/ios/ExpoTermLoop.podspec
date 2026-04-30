Pod::Spec.new do |s|
  s.name           = 'ExpoTermLoop'
  s.version        = '1.0.0'
  s.summary        = 'Raw TCP + NDJSON client for termloop control bridge'
  s.description    = 'Native module that opens plain TCP connections and frames newline-delimited JSON messages for the termloop socket bridge.'
  s.author         = 'dev'
  s.homepage       = 'https://github.com/example'
  s.license        = 'MIT'
  s.platforms      = { :ios => '17.0' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
end
