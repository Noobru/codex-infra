param([ValidateSet('Inspect','Quarantine')][string]$Action = 'Inspect')
$ErrorActionPreference = 'Stop'
# Only disposable Windows socket directories. Never follow, delete or read their contents.
$localRoot = [Environment]::GetFolderPath('LocalApplicationData')
$targets = @(
    @{ relative = 'Docker\run'; names = @('sailor-ingest.sock','dockerInference','dockerEthernetVfkit','userAnalyticsOtlpHttp.sock') },
    @{ relative = 'docker-secrets-engine'; names = @('engine.sock') }
)
function Get-DockerOwners {
    @(Get-Process -Name 'com.docker.backend','Docker Desktop','com.docker.build','vpnkit' -ErrorAction SilentlyContinue | Select-Object ProcessName,Id)
}
function Get-SocketInventory {
    @($targets | ForEach-Object {
        $definition = $_
        $directory = [IO.Path]::GetFullPath((Join-Path $localRoot $definition.relative))
        $exists = Test-Path -LiteralPath $directory
        $safe = $true
        $entries = @()
        if ($exists) {
            $item = Get-Item -LiteralPath $directory -Force
            $parent = Get-Item -LiteralPath (Split-Path $directory -Parent) -Force
            $safe = $item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and -not ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint)
            $entries = @(Get-ChildItem -LiteralPath $directory -Force | ForEach-Object {
                $known = $definition.names -contains $_.Name
                $socket = -not $_.PSIsContainer -and $_.Length -eq 0 -and [bool]($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
                if (-not ($known -and $socket)) { $safe = $false }
                @{ name = $_.Name; socketEntry = $socket; known = $known }
            })
        }
        @{ relative = $definition.relative; exists = $exists; safe = [bool]$safe; entries = $entries }
    })
}
$owners = @(Get-DockerOwners)
$inventory = @(Get-SocketInventory)
$logPath = Join-Path $localRoot 'Docker\log\host\com.docker.backend.exe.log'
$knownError = $false
if (Test-Path -LiteralPath $logPath) {
    $lines = Get-Content -LiteralPath $logPath -Tail 300
    $knownError = [bool]($lines | Where-Object { $_ -match 'starting services:' -and $_ -match '(sailor-ingest|engine)\.sock' -and $_ -match 'rename ' -and $_ -match 'The file cannot be accessed by the system' })
}
if ($Action -eq 'Inspect') {
    @{ owners = $owners; directories = $inventory; knownSocketError = $knownError } | ConvertTo-Json -Depth 8 -Compress
    exit 0
}
# Recheck immediately before moving; no force, recursive delete, overwrite or arbitrary path input.
if ($owners.Count -gt 0) { throw 'Docker processes are active; close Docker before socket recovery.' }
if (-not ($inventory | Where-Object { $_.exists -and $_.entries.Count -gt 0 })) { throw 'No known orphan socket entries remain; no recovery attempted.' }
if ($inventory | Where-Object { -not $_.safe }) { throw 'Unexpected files or links in socket directories; manual inspection required.' }
$moved = @()
$suffix = '.recovery-' + [Guid]::NewGuid().ToString()
try { foreach ($item in $inventory) {
    if (-not $item.exists -or $item.entries.Count -eq 0) { continue }
    if ((Get-DockerOwners).Count -gt 0) { throw 'Docker started during recovery; remaining directories preserved.' }
    $fresh = @(Get-SocketInventory)
    if ($fresh | Where-Object { -not $_.safe }) { throw 'Socket directory contents changed; remaining directories preserved.' }
    $sourcePath = [IO.Path]::GetFullPath((Join-Path $localRoot $item.relative))
    $destinationPath = $sourcePath + $suffix
    if (-not $sourcePath.StartsWith($localRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path $sourcePath -Parent) -ne (Split-Path $destinationPath -Parent)) { throw 'Recovery path escaped its local scope.' }
    Rename-Item -LiteralPath $sourcePath -NewName ([IO.Path]::GetFileName($destinationPath)) -ErrorAction Stop
    $moved += @{ original = $item.relative; preserved = $item.relative + $suffix }
} } catch {
    # Partial progress is data, even when the second directory cannot be renamed.
    @{ quarantined = $moved; deleted = $false; error = $_.Exception.Message } | ConvertTo-Json -Depth 5 -Compress
    exit 0
}
@{ quarantined = $moved; deleted = $false } | ConvertTo-Json -Depth 5 -Compress
