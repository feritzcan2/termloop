Pod::Spec.new do |s|
  s.name           = 'WatchSync'
  s.version        = '1.0.0'
  s.summary        = 'WatchConnectivity bridge for the TermLoop companion watch app'
  s.description    = 'Forwards TermLoop mobile-access gateway credentials from the phone to the paired watch.'
  s.author         = 'TermLoop'
  s.homepage       = 'https://termloop.ai'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.license        = { :type => 'MIT' }
  s.source_files   = '**/*.{h,m,swift}'
end
