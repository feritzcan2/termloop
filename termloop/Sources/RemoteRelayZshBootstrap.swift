import Foundation

struct RemoteRelayZshBootstrap {
    let shellStateDir: String

    private var sharedHistoryLines: [String] {
        [
            "if [ -z \"${HISTFILE:-}\" ] || [ \"$HISTFILE\" = \"\(shellStateDir)/.zsh_history\" ]; then export HISTFILE=\"$TERMLOOP_REAL_ZDOTDIR/.zsh_history\"; fi",
        ]
    }

    var zshEnvLines: [String] {
        [
            "[ -f \"$TERMLOOP_REAL_ZDOTDIR/.zshenv\" ] && source \"$TERMLOOP_REAL_ZDOTDIR/.zshenv\"",
            "if [ -n \"${ZDOTDIR:-}\" ] && [ \"$ZDOTDIR\" != \"\(shellStateDir)\" ]; then export TERMLOOP_REAL_ZDOTDIR=\"$ZDOTDIR\"; fi",
        ] + sharedHistoryLines + [
            "export ZDOTDIR=\"\(shellStateDir)\"",
        ]
    }

    var zshProfileLines: [String] {
        [
            "[ -f \"$TERMLOOP_REAL_ZDOTDIR/.zprofile\" ] && source \"$TERMLOOP_REAL_ZDOTDIR/.zprofile\"",
        ]
    }

    func zshRCLines(commonShellLines: [String]) -> [String] {
        sharedHistoryLines + [
            "[ -f \"$TERMLOOP_REAL_ZDOTDIR/.zshrc\" ] && source \"$TERMLOOP_REAL_ZDOTDIR/.zshrc\"",
        ] + commonShellLines
    }

    var zshLoginLines: [String] {
        [
            "[ -f \"$TERMLOOP_REAL_ZDOTDIR/.zlogin\" ] && source \"$TERMLOOP_REAL_ZDOTDIR/.zlogin\"",
        ]
    }
}
