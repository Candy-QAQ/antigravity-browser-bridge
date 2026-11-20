$ErrorActionPreference = 'Stop'

$HostName = 'com.antigravity.browser_bridge'
$Targets = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
)

foreach ($RegPath in $Targets) {
  if (Test-Path $RegPath) {
    Remove-Item -Path $RegPath -Force
    Write-Output "Removed: $RegPath"
  } else {
    Write-Output "Not present: $RegPath"
  }
}
