#!/usr/bin/env powershell

# @raycast.schemaVersion 1
# @raycast.title TermLoop Open
# @raycast.mode compact
# @raycast.platform windows
# @raycast.packageName TermLoop
# @raycast.icon ../../clients/desktop/src/assets/termloop-main-icon.png
# @raycast.description Open the existing Windows desktop build.
# @raycast.needsConfirmation false

$ErrorActionPreference = 'Stop'

try {
    $appDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../clients/desktop/out/win-unpacked'))
    $appPath = Join-Path $appDirectory 'TermLoop Next.exe'

    if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) {
        throw "TermLoop Windows build not found: $appPath. Build the Windows desktop package first."
    }

    Start-Process -FilePath $appPath -WorkingDirectory $appDirectory
    Write-Output 'TermLoop opened.'
    exit 0
} catch {
    Write-Output $_.Exception.Message
    exit 1
}
