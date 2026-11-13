Pod::Spec.new do |s|
  s.name           = 'ShareInbox'
  s.version        = '1.0.0'
  s.summary        = 'Reads images staged by the TermLoop share extension'
  s.description    = 'Reads and removes image batches that the share extension stages in the TermLoop App Group.'
  s.author         = 'TermLoop'
  s.homepage       = 'https://termloop.ai'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.license        = { :type => 'MIT' }
  s.source_files   = '**/*.{h,m,swift}'
end
