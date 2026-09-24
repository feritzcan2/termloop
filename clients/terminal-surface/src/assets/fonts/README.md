# Bundled terminal font

`JetBrainsMono-Variable.ttf` and `JetBrainsMono-Italic-Variable.ttf` are the
variable faces Ghostty embeds and uses when `font-family` is left unset. The
terminal surface bundles the same files from the vendored Ghostty dependency so
weight and italic rendering do not depend on fonts installed on the host.

- JetBrains Mono — SIL Open Font License 1.1
- Copyright 2020 The JetBrains Mono Project Authors
  <https://github.com/JetBrains/JetBrainsMono/blob/master/OFL.txt>

The files are copied from the JetBrains Mono 2.304 dependency pinned by the
vendored Ghostty source in the legacy TermLoop repository.

This font is for the terminal grid only. Sidebar and chrome stay on the system
monospace face, which is what the AppKit build uses for its own chrome.
