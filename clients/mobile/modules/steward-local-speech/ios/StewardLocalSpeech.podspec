Pod::Spec.new do |s|
  s.name             = 'StewardLocalSpeech'
  s.version          = '1.0.0'
  s.summary          = 'On-device speech fallback for Steward replies'
  s.description      = 'Speaks Steward text with AVSpeechSynthesizer when remote audio is unavailable.'
  s.author           = 'TermLoop'
  s.homepage         = 'https://termloop.ai'
  s.platforms        = { :ios => '16.4' }
  s.source           = { git: '' }
  s.static_framework = true
  s.license          = { :type => 'MIT' }
  s.dependency 'ExpoModulesCore'
  s.frameworks       = 'AVFoundation'
  s.source_files     = '**/*.{h,m,swift}'
end
