$ErrorActionPreference = 'Stop'

$HostName = 'com.antigravity.browser_bridge'
$ExtensionId = 'mnccmppmfbpfjimoacoamffodlepbjhl'
$NativeHostDir = $PSScriptRoot
$PluginRoot = Split-Path -Parent $NativeHostDir
$CmdPath = Join-Path $NativeHostDir 'native-host.cmd'
$ManifestPath = Join-Path $NativeHostDir "$HostName.json"
$McpConfigPath = Join-Path $PluginRoot 'mcp_config.json'
$McpServerPath = Join-Path $PluginRoot 'server\mcp-server.mjs'

# 1. Detect Node.js executable
$NodeExe = $null
$NodeCandidates = @(
  'C:\nodejs\node.exe',
  "$env:ProgramFiles\nodejs\node.exe",
  (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue)
)
foreach ($c in $NodeCandidates) {
  if ($c -and (Test-Path $c)) {
    $NodeExe = $c
    break
  }
}
if (-not $NodeExe) {
  $NodeExe = 'node'
}

# 2. Generate com.antigravity.browser_bridge.json with current absolute path
$ManifestObj = [ordered]@{
  name = $HostName
  description = 'Antigravity Browser Bridge Native Messaging Host'
  path = $CmdPath
  type = 'stdio'
  allowed_origins = @(
    "chrome-extension://$ExtensionId/"
  )
}
$ManifestJson = $ManifestObj | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($ManifestPath, "$ManifestJson`n", [System.Text.UTF8Encoding]::new($false))

# 3. Generate mcp_config.json with current Node.js & plugin server path
$McpObj = [ordered]@{
  mcpServers = [ordered]@{
    'browser-bridge' = [ordered]@{
      command = $NodeExe
      args = @($McpServerPath)
    }
  }
}
$McpJson = $McpObj | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($McpConfigPath, "$McpJson`n", [System.Text.UTF8Encoding]::new($false))

# 4. Register Native Messaging Host for Chrome & Edge (Current User)
$Targets = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
)

foreach ($RegPath in $Targets) {
  if (-not (Test-Path $RegPath)) {
    New-Item -Path $RegPath -Force | Out-Null
  }
  Set-ItemProperty -Path $RegPath -Name '(default)' -Value $ManifestPath
  $actual = (Get-ItemProperty -Path $RegPath).'(default)'
  if ($actual -ne $ManifestPath) {
    throw "Registry verification failed for $RegPath (got: $actual)"
  }
  Write-Output "Registered: $RegPath -> $actual"
}

Write-Output "Configured mcp_config.json -> $NodeExe $McpServerPath"
