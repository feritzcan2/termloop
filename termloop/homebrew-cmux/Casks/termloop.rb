cask "termloop" do
  version "0.62.1"
  sha256 "3be67bc3600fdde1c2b62c02c448235bd81ad0bf0772ff33353a6d91cc4b19fe"

  url "https://github.com/feritzcan2/termloop/releases/download/v#{version}/termloop-macos.dmg"
  name "TermLoop"
  desc "Lightweight native macOS terminal with vertical tabs for AI coding agents"
  homepage "https://termloop.ai"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :sonoma"

  app "TermLoop.app"
  binary "#{appdir}/TermLoop.app/Contents/Resources/bin/termloop"

  zap trash: [
    "~/Library/Application Support/TermLoop",
    "~/Library/Caches/TermLoop",
    "~/Library/Preferences/com.termloop.app.plist",
  ]
end
