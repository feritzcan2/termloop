#!/usr/bin/env powershell

# @raycast.schemaVersion 1
# @raycast.title TermLoop Open
# @raycast.mode fullOutput
# @raycast.platform windows
# @raycast.packageName TermLoop
# @raycast.icon ../../clients/desktop/src/assets/termloop-main-icon.png
# @raycast.description Rebuild and restart the Windows desktop app from this checkout.
# @raycast.needsConfirmation false

function Invoke-TermLoopBuildCommand {
    param([string]$Command, [string[]]$Arguments)

    $null = Get-Command $Command -ErrorAction Stop
    $previousPreference = $ErrorActionPreference
    try {
        # Windows PowerShell wraps redirected native stderr as ErrorRecords.
        # Cargo writes normal progress there, so stream it as text and decide
        # success from the exit code even when Raycast captures the output.
        $ErrorActionPreference = 'Continue'
        $PSNativeCommandUseErrorActionPreference = $false
        & $Command @Arguments 2>&1 | ForEach-Object { Write-Output "$_" }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) {
        throw "$Command failed with exit code $exitCode."
    }
}

function Stop-TermLoopDesktop {
    param([string]$AppPath)

    $sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    # The name only narrows discovery. Only this exact executable in this
    # Windows session may be closed; other checkouts and applications stay open.
    $processes = @(Get-Process -Name 'TermLoop Next' -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -eq $AppPath -and $_.SessionId -eq $sessionId
    })

    foreach ($process in $processes) {
        if ($process.HasExited) { continue }
        # Keep an OS handle to the verified process, including during exit waits.
        $null = $process.Handle
        if ($process.MainWindowHandle -ne 0 -and -not $process.CloseMainWindow()) {
            throw "Could not close TermLoop (PID $($process.Id)). Close its window and retry."
        }
    }

    # Closing the window flushes desktop state and shuts down its owned daemon.
    # Wait for Electron helpers too, so packaging can replace their locked files.
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    foreach ($process in $processes) {
        if ($process.HasExited) { continue }
        $remainingMs = [Math]::Max(0, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        if (-not $process.WaitForExit($remainingMs)) {
            throw "TermLoop did not exit (PID $($process.Id)). Close it and retry."
        }
    }
}

function Open-TermLoopDesktop {
    $ErrorActionPreference = 'Stop'
    $checkout = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $appDirectory = Join-Path $checkout 'clients/desktop/out/win-unpacked'
    $appPath = Join-Path $appDirectory 'TermLoop Next.exe'

    Push-Location -LiteralPath $checkout
    try {
        # Fail before closing the running app if a build prerequisite is missing.
        foreach ($command in @('cargo.exe', 'pnpm.cmd', 'node.exe')) {
            $null = Get-Command $command -ErrorAction Stop
        }

        Write-Output 'Building the TermLoop daemon and desktop...'
        Invoke-TermLoopBuildCommand 'cargo.exe' @('build', '--release', '--target-dir', 'target', '-p', 'termloop-server', '-p', 'termloop-companion')
        Invoke-TermLoopBuildCommand 'pnpm.cmd' @('--filter', '@termloop/desktop', 'build')
        Invoke-TermLoopBuildCommand 'node.exe' @('tools/skills-manager/fetch-cli.mjs', '--output', 'target/release/skills-manager-cli.exe')

        Write-Output 'Closing the previous TermLoop build...'
        Stop-TermLoopDesktop -AppPath $appPath

        Write-Output 'Packaging the new Windows build...'
        Invoke-TermLoopBuildCommand 'pnpm.cmd' @('--filter', '@termloop/desktop', 'exec', 'electron-builder', '--dir', '--config', 'electron-builder.yml')
    } finally {
        Pop-Location
    }

    if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) {
        throw "TermLoop Windows build not found: $appPath."
    }

    $started = Start-Process -FilePath $appPath -WorkingDirectory $appDirectory -PassThru
    if ($started.WaitForExit(1500)) {
        throw "The new TermLoop build exited immediately (code $($started.ExitCode)). Another TermLoop installation may still be running."
    }
    Write-Output "New TermLoop build opened (PID $($started.Id))."
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Open-TermLoopDesktop
        exit 0
    } catch {
        Write-Output $_.Exception.Message
        exit 1
    }
}
