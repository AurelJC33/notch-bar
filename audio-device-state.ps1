param(
  [string]$FixturePath = '',
  [switch]$Watch,
  [ValidateRange(250, 10000)][int]$PollMilliseconds = 750
)

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$script:audioEndpointsCache = @()
$script:bluetoothDevicesCache = @()
$script:mediaDevicesCache = @()
$script:audioEndpointsRefreshedAt = [DateTimeOffset]::MinValue
$script:bluetoothDevicesRefreshedAt = [DateTimeOffset]::MinValue
$script:mediaDevicesRefreshedAt = [DateTimeOffset]::MinValue

function Get-Value($Device, [string]$Name) {
  if ($null -eq $Device) { return $null }
  $property = $Device.PSObject.Properties[$Name]
  if ($null -ne $property) { return $property.Value }
  return $null
}

function Clean-DeviceName([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name)) { return '' }
  $clean = $Name.Trim()
  # Use the outermost parenthesis pair. Drivers such as Intel(R) otherwise
  # collapse to the single letter R and can be falsely matched together.
  if ($clean -match '^[^(]*\((.*)\)\s*$') { $clean = $Matches[1] }
  $clean = $clean -replace '(?i)\bStereo\b', ''
  $clean = $clean -replace '(?i)\bHands[- ]?Free( AG Audio)?\b', ''
  $clean = $clean -replace '(?i)\bHeadphones?\b', ''
  $clean = $clean -replace '(?i)\bHeadset\b', ''
  $clean = $clean -replace '(?i)\bSpeakers?\b', ''
  $clean = $clean -replace '(?i)\bTransport\b|\bAvrcp\b|\bWireless\b|\bBluetooth\b|\bAudio\b|\bDevice\b|\bService\b', ''
  $clean = $clean -replace '\s+', ' '
  return $clean.Trim(' ','-','(',')')
}

function Convert-ToBatteryPercent($Value) {
  if ($null -eq $Value) { return $null }
  try {
    $number = [double]$Value
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) { return $null }
    if ($number -lt 0 -or $number -gt 100) { return $null }
    return [int][Math]::Round($number, 0, [MidpointRounding]::AwayFromZero)
  } catch {
    return $null
  }
}

function Read-PnpPropertyValue($Device, [string]$PropertyKey) {
  $instanceId = [string](Get-Value $Device 'InstanceId')
  if ([string]::IsNullOrWhiteSpace($instanceId)) { return $null }
  try {
    $property = Get-PnpDeviceProperty -InstanceId $instanceId -KeyName $PropertyKey -ErrorAction SilentlyContinue
    if ($null -eq $property) { return $null }
    return (Convert-ToBatteryPercent $property.Data)
  } catch {
    return $null
  }
}

function Get-BatteryPercent($Device, [object[]]$RelatedDevices = @()) {
  # Test fixtures remain deterministic while the real path reads the Windows
  # PnP battery properties exposed by Bluetooth/audio device nodes.
  $fixtureValue = Get-Value $Device 'BatteryPercent'
  $fixtureBattery = Convert-ToBatteryPercent $fixtureValue
  if ($null -ne $fixtureBattery) { return $fixtureBattery }

  foreach ($propertyKey in @('DEVPKEY_Bluetooth_BatteryLevel', 'DEVPKEY_Device_BatteryLevel')) {
    $battery = Read-PnpPropertyValue $Device $propertyKey
    if ($null -ne $battery) { return $battery }
  }

  # Some Windows Bluetooth stacks expose the battery on an associated media
  # service node instead of the Bluetooth node itself. Keep the lookup bounded
  # and name-scored so a refresh does not scan arbitrary PnP properties.
  $deviceName = [string](Get-Value $Device 'FriendlyName')
  foreach ($related in @($RelatedDevices)) {
    if ($null -eq $related) { continue }
    $score = Score-NameMatch $deviceName ([string](Get-Value $related 'FriendlyName'))
    if ($score -lt 50) { continue }
    foreach ($propertyKey in @('DEVPKEY_Bluetooth_BatteryLevel', 'DEVPKEY_Device_BatteryLevel')) {
      $battery = Read-PnpPropertyValue $related $propertyKey
      if ($null -ne $battery) { return $battery }
    }
  }

  return $null
}

function Get-ContainerId($Device) {
  $direct = [string](Get-Value $Device 'ContainerId')
  if (-not [string]::IsNullOrWhiteSpace($direct)) { return $direct }
  # Looking up every endpoint's PnP properties can block for seconds on some
  # Bluetooth stacks. Names are sufficient for normal Windows audio endpoints;
  # a container id is still used whenever the device enumeration provides one.
  return ''
}

function Guess-Type([string]$Name) {
  if ($Name -match '(?i)airpods|earbuds?|earphones?|buds?') { return 'earbuds' }
  return 'headphones'
}

function Score-NameMatch([string]$A, [string]$B) {
  if ([string]::IsNullOrWhiteSpace($A) -or [string]::IsNullOrWhiteSpace($B)) { return 0 }
  $aClean = (Clean-DeviceName $A).ToLowerInvariant()
  $bClean = (Clean-DeviceName $B).ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($aClean) -or [string]::IsNullOrWhiteSpace($bClean)) { return 0 }
  if ($aClean -eq $bClean) { return 100 }
  if ($aClean.Contains($bClean) -or $bClean.Contains($aClean)) { return 80 }
  $score = 0
  foreach ($token in ($aClean -split '[^a-z0-9]+' | Where-Object { $_.Length -ge 3 })) {
    if ($bClean.Contains($token)) { $score += 10 }
  }
  return $score
}

function Get-DeviceLists([string]$Path) {
  if (-not [string]::IsNullOrWhiteSpace($Path)) {
    $fixture = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    return @{
      AudioEndpoints = @($fixture.audioEndpoints | Where-Object { [string]$_.Status -eq 'OK' })
      BluetoothDevices = @($fixture.bluetoothDevices | Where-Object { [string]$_.Status -eq 'OK' })
      MediaDevices = @()
    }
  }
  $now = [DateTimeOffset]::UtcNow
  if (($now - $script:audioEndpointsRefreshedAt).TotalMilliseconds -ge 2000) {
    $script:audioEndpointsCache = @(Get-PnpDevice -Class AudioEndpoint -PresentOnly 2>$null | Where-Object { $_.Status -eq 'OK' })
    $script:audioEndpointsRefreshedAt = $now
  }
  if (($now - $script:bluetoothDevicesRefreshedAt).TotalMilliseconds -ge 4000) {
    $script:bluetoothDevicesCache = @(Get-PnpDevice -Class Bluetooth -PresentOnly 2>$null | Where-Object { $_.Status -eq 'OK' })
    $script:bluetoothDevicesRefreshedAt = $now
  }
  if (($now - $script:mediaDevicesRefreshedAt).TotalMilliseconds -ge 4000) {
    $script:mediaDevicesCache = @(Get-PnpDevice -Class Media -PresentOnly 2>$null | Where-Object { $_.Status -eq 'OK' })
    $script:mediaDevicesRefreshedAt = $now
  }
  return @{
    AudioEndpoints = $script:audioEndpointsCache
    BluetoothDevices = $script:bluetoothDevicesCache
    MediaDevices = $script:mediaDevicesCache
  }
}

function Get-AudioAccessoryState([string]$Path) {
  $devices = Get-DeviceLists $Path
  $audioEndpoints = @($devices.AudioEndpoints)
  $bluetoothDevices = @($devices.BluetoothDevices)
  $mediaDevices = @($devices.MediaDevices)
  $best = $null

  foreach ($endpoint in $audioEndpoints) {
    $friendlyName = [string](Get-Value $endpoint 'FriendlyName')
    $endpointContainer = Get-ContainerId $endpoint
    $bestBluetooth = $null
    $bestBluetoothScore = -1
    foreach ($bluetooth in $bluetoothDevices) {
      $sameContainer = $endpointContainer -and $endpointContainer -eq (Get-ContainerId $bluetooth)
      $nameScore = Score-NameMatch $friendlyName ([string](Get-Value $bluetooth 'FriendlyName'))
      $score = if ($sameContainer) { 1000 + $nameScore } else { $nameScore }
      if ($score -gt $bestBluetoothScore) {
        $bestBluetoothScore = $score
        $bestBluetooth = $bluetooth
      }
    }

    $score = 0
    if ($friendlyName -match '(?i)headphones?|headset|earphones?|earbuds?|airpods|buds?') { $score += 200 }
    if ($bestBluetoothScore -ge 50) { $score += 150 + $bestBluetoothScore }
    if ($friendlyName -match '(?i)quietcomfort|bose|beats|jabra|sennheiser|sony|wh-|wf-') { $score += 50 }
    if ($score -le 0) { continue }
    if ($null -eq $best -or $score -gt $best.Score) {
      $best = @{ Endpoint = $endpoint; Bluetooth = $bestBluetooth; Score = $score }
    }
  }

  if ($null -ne $best) {
    $endpoint = $best.Endpoint
    $bluetooth = $best.Bluetooth
    $name = Clean-DeviceName ([string](Get-Value $endpoint 'FriendlyName'))
    $bluetoothName = if ($bluetooth) { Clean-DeviceName ([string](Get-Value $bluetooth 'FriendlyName')) } else { '' }
    if (-not [string]::IsNullOrWhiteSpace($bluetoothName)) { $name = $bluetoothName }
    if ([string]::IsNullOrWhiteSpace($name)) { $name = [string](Get-Value $endpoint 'FriendlyName') }
    $battery = if ($bluetooth) { Get-BatteryPercent $bluetooth $mediaDevices } else { $null }
    if ($null -eq $battery) { $battery = Get-BatteryPercent $endpoint $mediaDevices }
    return [ordered]@{
      connected = $true
      id = [string](Get-Value $endpoint 'InstanceId')
      name = $name
      batteryPercent = $battery
      deviceType = (Guess-Type $name)
    }
  }


  return [ordered]@{ connected = $false; id = ''; name = ''; batteryPercent = $null; deviceType = 'headphones' }
}

if ($Watch) {
  $lastJson = ''
  while ($true) {
    $state = Get-AudioAccessoryState $FixturePath
    $json = $state | ConvertTo-Json -Compress
    if ($json -ne $lastJson) {
      [Console]::Out.WriteLine($json)
      [Console]::Out.Flush()
      $lastJson = $json
    }
    Start-Sleep -Milliseconds $PollMilliseconds
  }
} else {
  Get-AudioAccessoryState $FixturePath | ConvertTo-Json -Compress
}
