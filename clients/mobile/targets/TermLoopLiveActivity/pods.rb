# The ActivityAttributes type must come from the same Swift module in both the
# app and WidgetKit extension. Link only the model subspec here; ExpoModulesCore
# remains confined to the main app's bridge subspec.
pod 'StewardLiveActivity/Model', :path => '../modules/steward-live-activity/ios'
