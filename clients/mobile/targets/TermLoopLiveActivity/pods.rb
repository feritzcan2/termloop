# Compile only the shared ActivityAttributes source for the extension. Giving
# the WidgetKit copy its own module prevents Xcode archive from assigning the
# app bridge and extension model the same AppIntents metadata output path.
pod 'StewardLiveActivityWidgetModel', :path => '../modules/steward-live-activity/ios'
