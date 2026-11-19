param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Queue TV Manager.lnk'
if ($Remove) {
    if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath }
    Write-Host 'Queue TV Manager startup shortcut removed.'
    exit
}
$projectPath = Split-Path $PSScriptRoot -Parent
$nodePath = (Get-Command node -ErrorAction Stop).Source
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $nodePath
$shortcut.Arguments = '"' + (Join-Path $projectPath 'src\server.js') + '"'
$shortcut.WorkingDirectory = $projectPath
$shortcut.Description = 'Start local Queue TV Manager after Windows sign-in'
$shortcut.WindowStyle = 7
$shortcut.Save()
Write-Host 'Queue TV Manager will start at Windows sign-in for this user.'
Write-Host 'The Windows session must stay signed in for the interactive login browser.'
