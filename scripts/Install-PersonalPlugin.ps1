#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$InfraRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$PluginCreatorRoot,
    [string]$PythonPath,
    [switch]$Update
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This installer creates a Windows junction and requires PowerShell 7 on Windows.' }

function Invoke-LocalCommand {
    param([string]$FilePath, [string[]]$Arguments)
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $FilePath
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'Could not start the local installation command.' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(60000)) {
            $process.Kill($true)
            $null = $process.WaitForExit(5000)
            throw 'Local installation command timed out; its owned process tree was stopped.'
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $null = $stderrTask.GetAwaiter().GetResult()
        # Stderr is drained but never persisted; installation receipts contain no raw command output.
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout.Trim() }
    } finally { $process.Dispose() }
}

function Invoke-RequiredCommand {
    param([string]$FilePath, [string[]]$Arguments, [string]$Stage)
    $result = Invoke-LocalCommand -FilePath $FilePath -Arguments $Arguments
    if ($result.ExitCode -ne 0) { throw "$Stage failed (exit $($result.ExitCode)); no raw account/config output was saved." }
    return $result.Stdout
}

function Get-NormalPath {
    param([string]$Value)
    return [System.IO.Path]::GetFullPath($Value).TrimEnd('\', '/')
}

$resolvedInfraRoot = (Resolve-Path -LiteralPath $InfraRoot).ProviderPath
$userProfileRoot = [Environment]::GetFolderPath('UserProfile')
if (-not $PluginCreatorRoot) { $PluginCreatorRoot = Join-Path $userProfileRoot '.codex/skills/.system/plugin-creator' }
if (-not $PythonPath) { $PythonPath = (Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
$creatorScripts = Join-Path $PluginCreatorRoot 'scripts'
$pluginName = 'codex-infra'
$pluginRoot = Join-Path $resolvedInfraRoot "plugins/$pluginName"
$manifestPath = Join-Path $pluginRoot '.codex-plugin/plugin.json'
$mcpConfigPath = Join-Path $pluginRoot '.mcp.json'
$buildEntry = Join-Path $resolvedInfraRoot 'dist/src/mcp.js'
$marketplacePath = Join-Path $userProfileRoot '.agents/plugins/marketplace.json'
$pluginParent = Join-Path $userProfileRoot 'plugins'
$junctionPath = Join-Path $pluginParent $pluginName
$expectedSource = "./plugins/$pluginName"

foreach ($requiredFile in @($manifestPath, $mcpConfigPath, $buildEntry,
    (Join-Path $creatorScripts 'validate_plugin.py'), (Join-Path $creatorScripts 'read_marketplace_name.py'),
    (Join-Path $creatorScripts 'update_plugin_cachebuster.py'), (Join-Path $creatorScripts 'create_basic_plugin.py'))) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) { throw "Missing prerequisite: $requiredFile" }
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.name -cne $pluginName -or $manifest.name -cnotmatch '^[a-z0-9]+(-[a-z0-9]+)*$') { throw 'Plugin folder and validated identifier must agree.' }
$mcp = Get-Content -LiteralPath $mcpConfigPath -Raw | ConvertFrom-Json
$server = $mcp.mcpServers.'codex-infra'
$nodePath = [string]$server.command
if (-not [System.IO.Path]::IsPathFullyQualified($nodePath) -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'The plugin must reference an existing absolute Node executable.' }
if (-not ($server.args -is [Array]) -or @($server.args).Count -ne 1 -or
    (Get-NormalPath $server.args[0]) -ine (Get-NormalPath $buildEntry) -or
    (Get-NormalPath $server.env.CODEX_INFRA_ROOT) -ine (Get-NormalPath $resolvedInfraRoot)) {
    throw 'MCP paths do not match InfraRoot. Update the source .mcp.json for the restored location before installation.'
}
$nodeVersion = Invoke-RequiredCommand -FilePath $nodePath -Arguments @('--version') -Stage 'Node version check'
$nodeVersionMatch = [regex]::Match($nodeVersion, '^v(\d+\.\d+\.\d+)$')
if (-not $nodeVersionMatch.Success -or [version]$nodeVersionMatch.Groups[1].Value -lt [version]'22.16.0') { throw 'Node 22.16.0 or newer is required.' }
$null = Invoke-RequiredCommand -FilePath $PythonPath -Arguments @('-B', (Join-Path $creatorScripts 'validate_plugin.py'), $pluginRoot) -Stage 'Plugin validation'

$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$tripleCpu = switch ($architecture) { 'x64' { 'x86_64' } 'arm64' { 'aarch64' } default { throw 'Unsupported Windows architecture.' } }
$cliPath = Join-Path $resolvedInfraRoot "node_modules/@openai/codex-win32-$architecture/vendor/$tripleCpu-pc-windows-msvc/bin/codex.exe"
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) { throw 'Pinned native Codex binary is absent. Run npm ci in InfraRoot first.' }
$infraPackage = Get-Content -LiteralPath (Join-Path $resolvedInfraRoot 'package.json') -Raw | ConvertFrom-Json
$installedPackage = Get-Content -LiteralPath (Join-Path $resolvedInfraRoot 'node_modules/@openai/codex/package.json') -Raw | ConvertFrom-Json
$pinnedVersion = [string]$infraPackage.dependencies.'@openai/codex'
if ($installedPackage.version -cne $pinnedVersion) { throw 'Installed Codex does not match the locally pinned dependency.' }
$cliVersion = Invoke-RequiredCommand -FilePath $cliPath -Arguments @('--version') -Stage 'Codex version check'
if ($cliVersion -notmatch ('\b' + [regex]::Escape($pinnedVersion) + '$')) { throw 'Native Codex version differs from the pinned dependency.' }

# Validate existing destinations before creating anything. Never replace a user path.
$existingParent = Get-Item -LiteralPath $pluginParent -Force -ErrorAction SilentlyContinue
if ($existingParent -and (-not $existingParent.PSIsContainer -or ($existingParent.Attributes -band [IO.FileAttributes]::ReparsePoint))) {
    throw 'The personal plugin parent must be an ordinary directory; existing links or files are preserved.'
}
$existingJunction = if ($existingParent) { Get-ChildItem -LiteralPath $pluginParent -Force | Where-Object Name -EQ $pluginName } else { $null }
if ($existingJunction) {
    $existingTargets = @($existingJunction.Target)
    if ($existingJunction.LinkType -ne 'Junction' -or $existingTargets.Count -ne 1 -or
        (Get-NormalPath $existingTargets[0]) -ine (Get-NormalPath $pluginRoot)) {
        throw 'The personal plugin path already exists and is not this installation junction. Nothing was replaced.'
    }
}

$marketplaceName = $null
$existingEntry = $null
if (Test-Path -LiteralPath $marketplacePath) {
    $marketplaceName = Invoke-RequiredCommand -FilePath $PythonPath -Arguments @('-B', (Join-Path $creatorScripts 'read_marketplace_name.py'), '--marketplace-path', $marketplacePath) -Stage 'Marketplace name validation'
    $marketplace = Get-Content -LiteralPath $marketplacePath -Raw | ConvertFrom-Json
    if (-not ($marketplace.plugins -is [Array])) { throw 'Existing marketplace plugins must be an array.' }
    $existingPluginEntries = @($marketplace.plugins | Where-Object name -CEQ $pluginName)
    if ($existingPluginEntries.Count -gt 1) { throw 'Duplicate existing plugin entries require inspection; marketplace was not changed.' }
    if ($existingPluginEntries.Count -eq 1) {
        $existingEntry = $existingPluginEntries[0]
        if ($existingEntry.source.source -cne 'local' -or $existingEntry.source.path -cne $expectedSource) {
            throw 'The existing marketplace entry has another source. It was not overwritten.'
        }
    }
}
if ($Update -and -not $existingEntry) { throw '-Update requires an existing validated personal marketplace entry; perform the first installation without -Update.' }

if (-not $existingParent) { $null = New-Item -ItemType Directory -Path $pluginParent }
if (-not $existingJunction) { $null = New-Item -ItemType Junction -Path $junctionPath -Target $pluginRoot }
if (-not $existingEntry) {
    $helperCode = @'
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from create_basic_plugin import update_marketplace_json
update_marketplace_json(Path(sys.argv[2]), None, sys.argv[3], 'AVAILABLE', 'ON_INSTALL', 'Productivity', False)
'@
    $null = Invoke-RequiredCommand -FilePath $PythonPath -Arguments @('-B', '-c', $helperCode, $creatorScripts, $marketplacePath, $pluginName) -Stage 'Canonical marketplace registration'
}
$marketplaceName = Invoke-RequiredCommand -FilePath $PythonPath -Arguments @('-B', (Join-Path $creatorScripts 'read_marketplace_name.py'), '--marketplace-path', $marketplacePath) -Stage 'Marketplace name read-back'
if ($Update) {
    $null = Invoke-RequiredCommand -FilePath $PythonPath -Arguments @('-B', (Join-Path $creatorScripts 'update_plugin_cachebuster.py'), $pluginRoot) -Stage 'Canonical plugin cachebuster update'
    $null = Invoke-RequiredCommand -FilePath $PythonPath -Arguments @('-B', (Join-Path $creatorScripts 'validate_plugin.py'), $pluginRoot) -Stage 'Updated plugin validation'
}

$identifier = "$pluginName@$marketplaceName"
$cliResult = Invoke-LocalCommand -FilePath $cliPath -Arguments @('plugin', 'add', $identifier)
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$receiptDirectory = Join-Path $resolvedInfraRoot ('artifacts/integration/plugin-install/' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
$null = New-Item -ItemType Directory -Path $receiptDirectory
$cliResultPath = Join-Path $receiptDirectory 'cli-result.json'
$receiptPath = Join-Path $receiptDirectory 'receipt.json'
@{
    operation = 'plugin add'; plugin = $identifier; exitCode = $cliResult.ExitCode;
    succeeded = ($cliResult.ExitCode -eq 0); cliVersion = $pinnedVersion
} | ConvertTo-Json | Set-Content -LiteralPath $cliResultPath -Encoding utf8NoBOM
@{
    capturedAt = [DateTime]::UtcNow.ToString('o'); infraRoot = $resolvedInfraRoot;
    plugin = $pluginName; pluginVersion = $manifest.version; source = $pluginRoot;
    marketplace = @{ name = $marketplaceName; path = $marketplacePath; source = $expectedSource };
    junction = @{ path = $junctionPath; target = $pluginRoot };
    nodeVersion = $nodeVersion; cliPath = $cliPath; cliVersion = $pinnedVersion;
    cliResultPath = $cliResultPath; update = [bool]$Update; desktopPickupVerified = $false
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receiptPath -Encoding utf8NoBOM
if ($cliResult.ExitCode -ne 0) { throw "Plugin installation failed (exit $($cliResult.ExitCode)). Receipt: $receiptPath" }
Write-Output "Plugin installation command succeeded. Receipt: $receiptPath"
Write-Output 'A new Codex task is still required to verify plugin, skill and MCP pickup.'
