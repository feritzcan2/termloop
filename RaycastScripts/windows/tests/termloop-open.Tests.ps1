. (Join-Path $PSScriptRoot '../termloop-open.ps1')

function New-TestDesktopProcess {
    param(
        [string]$Path,
        [int]$SessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId,
        [int]$WindowHandle = 1,
        [bool]$CloseSucceeds = $true,
        [bool]$Exits = $true
    )

    $process = [pscustomobject]@{
        Id = 42
        Path = $Path
        SessionId = $SessionId
        Handle = 123
        MainWindowHandle = $WindowHandle
        HasExited = $false
        CloseSucceeds = $CloseSucceeds
        Exits = $Exits
        Closed = $false
        Waited = $false
        ExitCode = 0
    }
    $process | Add-Member ScriptMethod CloseMainWindow {
        $this.Closed = $true
        return $this.CloseSucceeds
    }
    $process | Add-Member ScriptMethod WaitForExit {
        param($timeout)
        if ($timeout -lt 0 -or $timeout -gt 15000) { throw "Unexpected timeout: $timeout" }
        $this.Waited = $true
        return $this.Exits
    }
    return $process
}

Describe 'TermLoop Windows restart ownership' {
    BeforeEach {
        $script:appPath = 'C:\checkout\clients\desktop\out\win-unpacked\TermLoop Next.exe'
        $script:desktop = New-TestDesktopProcess $script:appPath
        $script:helper = New-TestDesktopProcess $script:appPath -WindowHandle 0
        $script:otherCheckout = New-TestDesktopProcess 'C:\another\TermLoop Next.exe'
        $script:otherSession = New-TestDesktopProcess $script:appPath -SessionId -1
        Mock Get-Process { @($script:desktop, $script:helper, $script:otherCheckout, $script:otherSession) }
    }

    It 'closes the exact desktop gracefully and waits for its helpers' {
        Stop-TermLoopDesktop $script:appPath
        $script:desktop.Closed | Should Be $true
        $script:desktop.Waited | Should Be $true
        $script:helper.Closed | Should Be $false
        $script:helper.Waited | Should Be $true
        $script:otherCheckout.Closed | Should Be $false
        $script:otherCheckout.Waited | Should Be $false
        $script:otherSession.Closed | Should Be $false
        $script:otherSession.Waited | Should Be $false
    }

    It 'supports opening when no desktop is running' {
        Mock Get-Process { @() }
        { Stop-TermLoopDesktop $script:appPath } | Should Not Throw
    }

    It 'skips a process which already exited' {
        $script:desktop.HasExited = $true
        Stop-TermLoopDesktop $script:appPath
        $script:desktop.Closed | Should Be $false
        $script:desktop.Waited | Should Be $false
    }

    It 'fails when the window refuses to close' {
        $script:desktop.CloseSucceeds = $false
        { Stop-TermLoopDesktop $script:appPath } | Should Throw 'Could not close TermLoop'
    }

    It 'fails when the old desktop or a helper has not exited' {
        $script:helper.Exits = $false
        { Stop-TermLoopDesktop $script:appPath } | Should Throw 'TermLoop did not exit'
    }
}

Describe 'TermLoop Windows rebuild and launch' {
    BeforeEach {
        $script:events = New-Object 'System.Collections.Generic.List[string]'
        $script:started = New-TestDesktopProcess 'unused' -Exits $false
        $script:failure = ''
        Mock Get-Command {
            if ($script:failure -eq 'prerequisite') { throw 'Missing build tool' }
            @{ Name = $Name }
        }
        Mock Invoke-TermLoopBuildCommand {
            if ($script:failure -eq 'compilation') { throw 'Compilation failed' }
            if ($script:failure -eq 'packaging' -and $Arguments -contains 'electron-builder') {
                throw 'Packaging failed'
            }
            $script:events.Add("$Command $($Arguments -join ' ')")
        }
        Mock Stop-TermLoopDesktop {
            if ($script:failure -eq 'shutdown') { throw 'TermLoop did not exit' }
            $script:events.Add('close')
        }
        Mock Test-Path { $script:failure -ne 'missing executable' }
        Mock Start-Process {
            $script:events.Add('launch')
            $script:started
        }
    }

    It 'builds before closing, packages after closing, and starts the fresh executable' {
        $locationBefore = (Get-Location).Path
        Open-TermLoopDesktop
        ($script:events -join '|') | Should Be (
            'cargo.exe build --release --target-dir target -p termloop-server -p termloop-companion|' +
            'pnpm.cmd --filter @termloop/desktop build|' +
            'node.exe tools/skills-manager/fetch-cli.mjs --output target/release/skills-manager-cli.exe|' +
            'close|pnpm.cmd --filter @termloop/desktop exec electron-builder --dir --config electron-builder.yml|launch'
        )
        (Get-Location).Path | Should Be $locationBefore
        Assert-MockCalled Start-Process -Times 1 -Exactly -Scope It -ParameterFilter {
            $FilePath -like '*\clients\desktop\out\win-unpacked\TermLoop Next.exe' -and
            $WorkingDirectory -eq (Split-Path -Parent $FilePath) -and $PassThru
        }
        $script:started.Waited | Should Be $true
    }

    It 'keeps the old app open when prerequisites are missing' {
        $script:failure = 'prerequisite'
        { Open-TermLoopDesktop } | Should Throw 'Missing build tool'
        Assert-MockCalled Stop-TermLoopDesktop -Times 0 -Exactly -Scope It
        Assert-MockCalled Start-Process -Times 0 -Exactly -Scope It
    }

    It 'keeps the old app open when compilation fails and restores the working directory' {
        $locationBefore = (Get-Location).Path
        $script:failure = 'compilation'
        { Open-TermLoopDesktop } | Should Throw 'Compilation failed'
        Assert-MockCalled Stop-TermLoopDesktop -Times 0 -Exactly -Scope It
        Assert-MockCalled Start-Process -Times 0 -Exactly -Scope It
        (Get-Location).Path | Should Be $locationBefore
    }

    It 'does not package or launch while the old desktop is still running' {
        $script:failure = 'shutdown'
        { Open-TermLoopDesktop } | Should Throw 'TermLoop did not exit'
        Assert-MockCalled Invoke-TermLoopBuildCommand -Times 0 -Exactly -Scope It -ParameterFilter {
            $Arguments -contains 'electron-builder'
        }
        Assert-MockCalled Start-Process -Times 0 -Exactly -Scope It
    }

    It 'does not launch stale output when packaging fails' {
        $script:failure = 'packaging'
        { Open-TermLoopDesktop } | Should Throw 'Packaging failed'
        Assert-MockCalled Start-Process -Times 0 -Exactly -Scope It
    }

    It 'reports a missing executable instead of success' {
        $script:failure = 'missing executable'
        { Open-TermLoopDesktop } | Should Throw 'TermLoop Windows build not found'
        Assert-MockCalled Start-Process -Times 0 -Exactly -Scope It
    }

    It 'reports an immediate single-instance exit even when its exit code is zero' {
        $script:started.Exits = $true
        { Open-TermLoopDesktop } | Should Throw 'The new TermLoop build exited immediately'
    }
}

Describe 'TermLoop native build command errors' {
    It 'streams successful stderr under Stop preference and redirected output' {
        $ErrorActionPreference = 'Stop'
        $output = Invoke-TermLoopBuildCommand 'cmd.exe' @('/d', '/c', 'echo compiler progress 1>&2') 2>&1
        ($output -join "`n").Trim() | Should Be 'compiler progress'
        @($output | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }).Count | Should Be 0
        $ErrorActionPreference | Should Be 'Stop'
    }

    It 'retains diagnostics and exit status when a redirected command fails' {
        $ErrorActionPreference = 'Stop'
        $script:buildOutput = New-Object 'System.Collections.Generic.List[string]'
        {
            Invoke-TermLoopBuildCommand 'cmd.exe' @('/d', '/c', 'echo actual compiler error 1>&2 & exit 7') 2>&1 |
                ForEach-Object { $script:buildOutput.Add("$_") }
        } | Should Throw 'failed with exit code 7'
        ($script:buildOutput -join "`n").Trim() | Should Be 'actual compiler error'
        $ErrorActionPreference | Should Be 'Stop'
    }

    It 'rejects a missing command instead of accepting a previous zero exit code' {
        cmd.exe /d /c exit 0
        { Invoke-TermLoopBuildCommand 'termloop-nonexistent-build-command.exe' @() } | Should Throw
    }

    It 'propagates a native nonzero exit code as a build failure' {
        { Invoke-TermLoopBuildCommand 'cmd.exe' @('/d', '/c', 'exit 7') } | Should Throw 'failed with exit code 7'
    }

    It 'accepts a successful native command' {
        { Invoke-TermLoopBuildCommand 'cmd.exe' @('/d', '/c', 'exit 0') } | Should Not Throw
    }
}
