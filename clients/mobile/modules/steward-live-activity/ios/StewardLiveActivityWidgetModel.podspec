Pod::Spec.new do |s|
  s.name             = 'StewardLiveActivityWidgetModel'
  s.module_name      = 'StewardLiveActivityWidgetModel'
  s.version          = '1.0.0'
  s.summary          = 'ActivityAttributes model compiled for the TermLoop WidgetKit extension'
  s.description      = 'Builds the shared Steward ActivityAttributes source in an extension-owned module so Xcode archive metadata outputs remain unique.'
  s.author           = 'TermLoop'
  s.homepage         = 'https://termloop.ai'
  s.platforms        = { :ios => '16.4' }
  s.source           = { git: '' }
  s.source_files     = 'Model/**/*.{h,m,swift}'
  s.frameworks       = 'ActivityKit'
  s.static_framework = true
  s.license          = { :type => 'MIT' }
end
