Pod::Spec.new do |s|
  s.name             = 'StewardLiveActivity'
  s.version          = '1.0.0'
  s.summary          = 'ActivityKit bridge for the TermLoop Steward voice session'
  s.description      = 'Shares the Steward voice ActivityAttributes with WidgetKit and controls the current Live Activity from Expo.'
  s.author           = 'TermLoop'
  s.homepage         = 'https://termloop.ai'
  s.platforms        = { :ios => '16.4' }
  s.source           = { git: '' }
  s.static_framework = true
  s.license          = { :type => 'MIT' }
  s.default_subspec  = 'Bridge'

  s.subspec 'Model' do |model|
    model.source_files = 'Model/**/*.{h,m,swift}'
    model.frameworks = 'ActivityKit'
  end

  s.subspec 'Bridge' do |bridge|
    bridge.source_files = 'Bridge/**/*.{h,m,swift}'
    bridge.dependency 'StewardLiveActivity/Model'
    bridge.dependency 'ExpoModulesCore'
  end
end
