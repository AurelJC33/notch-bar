$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
})[0]

function Await-Result($operation, [Type]$resultType) {
  $method = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $method.Invoke($null, @($operation))
  $task.Wait()
  return $task.Result
}

function Write-JsonLine($value) {
  try {
    $json = $value | ConvertTo-Json -Compress -Depth 8
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  } catch {
    [Console]::Out.WriteLine('{"type":"diagnostic","level":"error","message":"json-serialization-failed"}')
    [Console]::Out.Flush()
  }
}

function Write-Diagnostic([string]$level, [string]$message) {
  Write-JsonLine @{ type = 'diagnostic'; level = $level; message = $message }
}

function Get-UnixMilliseconds($dateTimeOffset) {
  try {
    return [int64]$dateTimeOffset.ToUniversalTime().ToUnixTimeMilliseconds()
  } catch {
    return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
}

function Get-Status($session) {
  if ($null -eq $session) { return 'Closed' }
  try {
    $playback = $session.GetPlaybackInfo()
    if ($null -eq $playback) { return 'Closed' }
    return [string]$playback.PlaybackStatus
  } catch {
    return 'Closed'
  }
}

function Get-TimelineUpdatedMs($session) {
  try {
    $timeline = $session.GetTimelineProperties()
    return Get-UnixMilliseconds $timeline.LastUpdatedTime
  } catch {
    return 0
  }
}

function Read-ThumbnailDataUrl($thumbnail) {
  if ($null -eq $thumbnail) { return '' }

  $stream = $null
  $dotNetStream = $null
  $memory = $null
  $input = $null
  $reader = $null
  try {
    $stream = Await-Result ($thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    if ($null -eq $stream) {
      Write-Diagnostic 'debug' 'artwork-open-returned-null'
      return ''
    }

    $size = [int64]$stream.Size
    if ($size -le 0 -or $size -gt 8388608) {
      Write-Diagnostic 'debug' ("artwork-size-rejected bytes=" + $size)
      return ''
    }

    $contentType = [string]$stream.ContentType
    if ($contentType -match ';') { $contentType = $contentType.Split(';')[0] }
    $contentType = $contentType.Trim().ToLowerInvariant()
    $bytes = $null

    # Preferred path: bridge the WinRT random-access stream to a regular .NET
    # Stream. This is more reliable than DataReader for artwork returned by
    # several desktop media apps (including some Deezer/Chromium builds).
    try {
      $dotNetStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
      $memory = [System.IO.MemoryStream]::new()
      $dotNetStream.CopyTo($memory)
      $bytes = $memory.ToArray()
    } catch {
      Write-Diagnostic 'debug' ("artwork-dotnet-stream-fallback:" + [string]$_.Exception.GetType().Name)
      $bytes = $null
    } finally {
      if ($null -ne $memory) { try { $memory.Dispose() } catch {}; $memory = $null }
      if ($null -ne $dotNetStream) { try { $dotNetStream.Dispose() } catch {}; $dotNetStream = $null }
    }

    # Fallback for Windows/PowerShell combinations where the .NET extension
    # method is unavailable.
    if ($null -eq $bytes -or $bytes.Length -eq 0) {
      $input = $stream.GetInputStreamAt(0)
      $reader = [Windows.Storage.Streams.DataReader]::new($input)
      $loaded = Await-Result ($reader.LoadAsync([uint32]$size)) ([uint32])
      if ([uint32]$loaded -le 0) {
        Write-Diagnostic 'debug' 'artwork-datareader-loaded-zero'
        return ''
      }
      $bytes = New-Object byte[] ([int]$loaded)
      $reader.ReadBytes($bytes)
    }

    if ($null -eq $bytes -or $bytes.Length -le 0) {
      Write-Diagnostic 'debug' 'artwork-empty'
      return ''
    }

    # GSMTC normally supplies the MIME type, but a few desktop media apps have
    # returned an empty or non-image content type. Derive it from the bytes
    # only when the signature is unambiguous; never fabricate a remote cover.
    if ($contentType -notmatch '^image/[a-z0-9.+-]+$') {
      if ($bytes.Length -ge 8 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47) {
        $contentType = 'image/png'
      } elseif ($bytes.Length -ge 3 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8 -and $bytes[2] -eq 0xFF) {
        $contentType = 'image/jpeg'
      } elseif ($bytes.Length -ge 6 -and (($bytes[0] -eq 0x47 -and $bytes[1] -eq 0x49 -and $bytes[2] -eq 0x46))) {
        $contentType = 'image/gif'
      } elseif ($bytes.Length -ge 12 -and $bytes[0] -eq 0x52 -and $bytes[1] -eq 0x49 -and $bytes[2] -eq 0x46 -and $bytes[3] -eq 0x46 -and $bytes[8] -eq 0x57 -and $bytes[9] -eq 0x45 -and $bytes[10] -eq 0x42 -and $bytes[11] -eq 0x50) {
        $contentType = 'image/webp'
      } else {
        Write-Diagnostic 'debug' 'artwork-content-type-unknown'
        return ''
      }
    }

    Write-Diagnostic 'debug' ("artwork-loaded bytes=" + $bytes.Length + " type=" + $contentType)
    return "data:$contentType;base64,$([Convert]::ToBase64String($bytes))"
  } catch {
    Write-Diagnostic 'warn' ("artwork-read-failed:" + [string]$_.Exception.GetType().Name + ':' + [string]$_.Exception.Message)
    return ''
  } finally {
    if ($null -ne $reader) { try { $reader.Dispose() } catch {} }
    if ($null -ne $input) { try { $input.Dispose() } catch {} }
    if ($null -ne $stream) { try { $stream.Dispose() } catch {} }
  }
}

$script:manager = $null
$script:activeSession = $null
$script:activeSource = ''
$script:activeTrackKey = ''
$script:artworkCache = @{}
$script:artworkAttempts = @{}
$script:sessionSubscribers = @()
$script:managerSubscribers = @()
$script:lastStateJson = ''
$script:lastState = @{ available = $false }
$script:shuttingDown = $false
$script:separator = [char]31
$script:lastManagerReacquireAt = [DateTimeOffset]::MinValue

function Get-SessionId($session) {
  if ($null -eq $session) { return '' }
  try {
    $source = [string]$session.SourceAppUserModelId
    $hash = [Runtime.CompilerServices.RuntimeHelpers]::GetHashCode($session)
    return "$source#$hash"
  } catch {
    return ''
  }
}

function Same-Session($left, $right) {
  if ($null -eq $left -or $null -eq $right) { return $false }
  try {
    return (Get-SessionId $left) -eq (Get-SessionId $right)
  } catch {
    return $false
  }
}

function Get-SessionScore($session, $currentSession) {
  if ($null -eq $session) { return -1000000 }
  $status = Get-Status $session
  $score = switch ($status) {
    'Playing'  { 100000 }
    'Paused'   { 50000 }
    'Changing' { 45000 }
    default    { 0 }
  }
  if (Same-Session $session $currentSession) { $score += 10000 }
  try {
    $source = [string]$session.SourceAppUserModelId
    if ($source -and $source -eq $script:activeSource) { $score += 2500 }
  } catch {}

  # LastUpdatedTime breaks ties between several playing browser/app sessions
  # without arbitrarily taking the first session returned by Windows.
  $updated = Get-TimelineUpdatedMs $session
  if ($updated -gt 0) { $score += ($updated / 1000000000000.0) }
  return [double]$score
}

function Select-ActiveSession {
  if ($null -eq $script:manager) { return $null }

  $current = $null
  try { $current = $script:manager.GetCurrentSession() } catch {}
  $sessions = @()
  try { $sessions = @($script:manager.GetSessions()) } catch {}

  $candidates = @()
  foreach ($session in $sessions) {
    if ($null -eq $session) { continue }
    $status = Get-Status $session
    if ($status -eq 'Playing' -or $status -eq 'Paused' -or $status -eq 'Changing') {
      $candidates += $session
    }
  }

  if ($null -ne $current) {
    $currentStatus = Get-Status $current
    if (($currentStatus -eq 'Playing' -or $currentStatus -eq 'Paused' -or $currentStatus -eq 'Changing') -and -not ($candidates | Where-Object { Same-Session $_ $current })) {
      $candidates += $current
    }
  }

  if ($candidates.Count -eq 0) { return $null }

  $best = $null
  $bestScore = -1000000
  foreach ($session in $candidates) {
    $score = Get-SessionScore $session $current
    if ($score -gt $bestScore) {
      $bestScore = $score
      $best = $session
    }
  }
  return $best
}

function Get-MediaProperties($session) {
  if ($null -eq $session) { return $null }
  try {
    return Await-Result ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  } catch {
    return $null
  }
}

function Build-State($session, [bool]$includeArtwork) {
  if ($null -eq $session) {
    return @{ available = $false; playing = $false; isPlaying = $false }
  }

  try {
    $props = Get-MediaProperties $session
    if ($null -eq $props) {
      return @{ available = $false; playing = $false; isPlaying = $false }
    }

    $playback = $session.GetPlaybackInfo()
    $timeline = $session.GetTimelineProperties()
    if ($null -eq $playback -or $null -eq $timeline) {
      return @{ available = $false; playing = $false; isPlaying = $false }
    }

    $controls = $playback.Controls
    $status = [string]$playback.PlaybackStatus
    if ($status -ne 'Playing' -and $status -ne 'Paused' -and $status -ne 'Changing') {
      return @{ available = $false; playing = $false; isPlaying = $false }
    }
    $isPlayingNow = ($status -eq 'Playing') -or ($status -eq 'Changing' -and [bool]$script:lastState.playing)

    $start = [Math]::Max(0.0, [double]$timeline.StartTime.TotalSeconds)
    $end = [Math]::Max($start, [double]$timeline.EndTime.TotalSeconds)
    $absolutePosition = [Math]::Max($start, [Math]::Min($end, [double]$timeline.Position.TotalSeconds))
    $position = [Math]::Max(0.0, $absolutePosition - $start)
    $duration = [Math]::Max(0.0, $end - $start)
    $source = [string]$session.SourceAppUserModelId
    $title = [string]$props.Title
    $artist = [string]$props.Artist
    $album = [string]$props.AlbumTitle
    $albumArtist = [string]$props.AlbumArtist
    $trackNumber = [int]$props.TrackNumber
    $trackKey = @($source, $title, $artist, $album, $albumArtist, $trackNumber) -join $script:separator
    $artworkKey = if ($album) { @($source, $albumArtist, $album) -join $script:separator } else { $trackKey }

    $artwork = ''
    $artworkResolved = $false
    if ($script:artworkCache.ContainsKey($artworkKey)) {
      $artwork = [string]$script:artworkCache[$artworkKey]
      $artworkResolved = $true
    } elseif ($includeArtwork) {
      $attempt = 1
      if ($script:artworkAttempts.ContainsKey($artworkKey)) {
        $attempt = [int]$script:artworkAttempts[$artworkKey] + 1
      }
      $script:artworkAttempts[$artworkKey] = $attempt

      if ($null -ne $props.Thumbnail) {
        $artwork = Read-ThumbnailDataUrl $props.Thumbnail
      } else {
        Write-Diagnostic 'debug' ("artwork-thumbnail-missing attempt=" + $attempt)
      }

      # Never cache an empty artwork result. Desktop apps can publish metadata
      # first and the Thumbnail a moment later during a track change. Caching
      # the first empty result made the cover impossible to recover afterward.
      if ($artwork) {
        $script:artworkCache[$artworkKey] = $artwork
        $script:artworkAttempts.Remove($artworkKey)
        $artworkResolved = $true
        if ($script:artworkCache.Count -gt 24) {
          $first = @($script:artworkCache.Keys)[0]
          $script:artworkCache.Remove($first)
        }
      } else {
        # Retry for several lightweight GSMTC poll cycles. Only mark the
        # artwork as absent after the app had time to publish its thumbnail.
        $artworkResolved = ($attempt -ge 10)
      }
    }

    $playbackType = ''
    try { if ($null -ne $playback.PlaybackType) { $playbackType = [string]$playback.PlaybackType } } catch {}

    $updatedMs = Get-UnixMilliseconds $timeline.LastUpdatedTime
    return @{
      available = $true
      playing = [bool]$isPlayingNow
      isPlaying = [bool]$isPlayingNow
      title = $title
      artist = $artist
      album = $album
      albumArtist = [string]$props.AlbumArtist
      subtitle = [string]$props.Subtitle
      trackNumber = [int]$props.TrackNumber
      artworkUrl = $(if ($artwork) { $artwork } else { $null })
      cover = $artwork
      artworkResolved = [bool]$artworkResolved
      sourceApp = $(if ($source) { $source } else { $null })
      source = $source
      playbackStatus = $status
      playbackType = $playbackType
      position = [Math]::Round($position, 3)
      duration = [Math]::Round($duration, 3)
      positionSeconds = [Math]::Round($position, 3)
      durationSeconds = [Math]::Round($duration, 3)
      timelineUpdatedAtMs = $updatedMs
      canPlay = [bool]$controls.IsPlayEnabled
      canPause = [bool]$controls.IsPauseEnabled
      canTogglePlayPause = [bool]$controls.IsPlayPauseToggleEnabled
      canNext = [bool]$controls.IsNextEnabled
      canPrevious = [bool]$controls.IsPreviousEnabled
      canSeek = [bool]$controls.IsPlaybackPositionEnabled
    }
  } catch {
    Write-Diagnostic 'warn' ("state-read-failed: " + [string]$_.Exception.Message)
    return @{ available = $false; playing = $false; isPlaying = $false }
  }
}

function Emit-State([bool]$force = $false, [bool]$withArtwork = $false) {
  $selected = Select-ActiveSession
  $script:activeSession = $selected

  if ($null -eq $selected) {
    $script:activeSource = ''
    $script:activeTrackKey = ''
    $state = @{ available = $false; playing = $false; isPlaying = $false }
    $json = $state | ConvertTo-Json -Compress -Depth 8
    if ($force -or $json -ne $script:lastStateJson) {
      $script:lastStateJson = $json
      $script:lastState = $state
      Write-JsonLine @{ type = 'state'; state = $state }
    }
    return
  }

  try { $script:activeSource = [string]$selected.SourceAppUserModelId } catch { $script:activeSource = '' }

  # First emit metadata/timeline immediately. Artwork is loaded only on track
  # changes and emitted in a second update so a slow thumbnail never delays the bubble.
  $state = Build-State $selected $false
  $trackKey = @($state.sourceApp, $state.title, $state.artist, $state.album, $state.albumArtist, $state.trackNumber) -join $script:separator
  $trackChanged = ($trackKey -ne $script:activeTrackKey)
  if ($trackChanged) { $script:activeTrackKey = $trackKey }

  $json = $state | ConvertTo-Json -Compress -Depth 8
  if ($force -or $trackChanged -or $json -ne $script:lastStateJson) {
    $script:lastStateJson = $json
    $script:lastState = $state
    Write-JsonLine @{ type = 'state'; state = $state }
  }

  $artworkKey = if ($state.album) { @($state.sourceApp, $state.albumArtist, $state.album) -join $script:separator } else { $trackKey }
  $artworkAttempts = 0
  if ($script:artworkAttempts.ContainsKey($artworkKey)) { $artworkAttempts = [int]$script:artworkAttempts[$artworkKey] }
  $needsArtworkRetry = (-not $script:artworkCache.ContainsKey($artworkKey)) -and ($artworkAttempts -lt 10)

  if (($trackChanged -or $withArtwork -or $needsArtworkRetry) -and $state.available) {
    $detailed = Build-State $selected $true
    $detailedKey = @($detailed.sourceApp, $detailed.title, $detailed.artist, $detailed.album, $detailed.albumArtist, $detailed.trackNumber) -join $script:separator
    if ($detailed.available -and $detailedKey -eq $script:activeTrackKey) {
      $detailedJson = $detailed | ConvertTo-Json -Compress -Depth 8
      if ($detailedJson -ne $script:lastStateJson) {
        $script:lastStateJson = $detailedJson
        $script:lastState = $detailed
        Write-JsonLine @{ type = 'state'; state = $detailed }
      }
    }
  }
}

function Clear-SessionSubscriptions {
  foreach ($id in $script:sessionSubscribers) {
    try { Unregister-Event -SourceIdentifier $id -ErrorAction SilentlyContinue } catch {}
  }
  $script:sessionSubscribers = @()
  Get-Event | Where-Object { $_.SourceIdentifier -like 'gsm-session-*' } | Remove-Event -ErrorAction SilentlyContinue
}

function Refresh-SessionSubscriptions([bool]$quiet = $false) {
  Clear-SessionSubscriptions
  if ($null -eq $script:manager) { return }
  $sessions = @()
  try { $sessions = @($script:manager.GetSessions()) } catch {}
  $index = 0
  foreach ($session in $sessions) {
    if ($null -eq $session) { continue }
    $id = Get-SessionId $session
    foreach ($eventName in @('MediaPropertiesChanged','PlaybackInfoChanged','TimelinePropertiesChanged')) {
      $sourceIdentifier = "gsm-session-$index-$eventName-$id"
      try {
        Register-ObjectEvent -InputObject $session -EventName $eventName -SourceIdentifier $sourceIdentifier | Out-Null
        $script:sessionSubscribers += $sourceIdentifier
      } catch {
        if (-not $quiet) { Write-Diagnostic 'debug' ("event-subscribe-failed:$eventName") }
      }
    }
    $index += 1
  }
}

function Clear-ManagerSubscriptions {
  foreach ($id in $script:managerSubscribers) {
    try { Unregister-Event -SourceIdentifier $id -ErrorAction SilentlyContinue } catch {}
  }
  $script:managerSubscribers = @()
  Get-Event | Where-Object { $_.SourceIdentifier -like 'gsm-manager-*' } | Remove-Event -ErrorAction SilentlyContinue
}

function Register-ManagerSubscriptions([bool]$quiet = $false) {
  foreach ($entry in @(
    @{ Name = 'CurrentSessionChanged'; Id = 'gsm-manager-current' },
    @{ Name = 'SessionsChanged'; Id = 'gsm-manager-sessions' }
  )) {
    try {
      Register-ObjectEvent -InputObject $script:manager -EventName $entry.Name -SourceIdentifier $entry.Id | Out-Null
      $script:managerSubscribers += $entry.Id
    } catch {
      if (-not $quiet) { Write-Diagnostic 'warn' ("manager-event-subscribe-failed:" + $entry.Name) }
    }
  }
}

function Reacquire-Manager {
  $now = [DateTimeOffset]::UtcNow
  if (($now - $script:lastManagerReacquireAt).TotalMilliseconds -lt 1500) {
    Emit-State $true $false
    return
  }
  $script:lastManagerReacquireAt = $now

  try {
    Clear-SessionSubscriptions
    Clear-ManagerSubscriptions
    $freshManager = Await-Result ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    if ($null -eq $freshManager) { throw 'GSMTC manager unavailable' }
    $script:manager = $freshManager
    Register-ManagerSubscriptions $true
    Refresh-SessionSubscriptions $true
    Emit-State $true $false
  } catch {
    Write-Diagnostic 'warn' ("gsm-manager-reacquire-failed: " + [string]$_.Exception.Message)
  }
}

function Initialize-Manager {
  $script:manager = Await-Result ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  if ($null -eq $script:manager) { throw 'GSMTC manager unavailable' }

  Register-ManagerSubscriptions
  Refresh-SessionSubscriptions
  Write-Diagnostic 'info' 'gsm-service-ready'
  Emit-State $true $true
}

function Execute-Command($commandObject) {
  $id = [string]$commandObject.id
  $command = [string]$commandObject.command
  $payload = $commandObject.payload
  $session = Select-ActiveSession
  if ($null -eq $session) {
    Write-JsonLine @{ type = 'response'; id = $id; ok = $false; error = 'no-active-session' }
    return
  }

  try {
    $playback = $session.GetPlaybackInfo()
    $controls = $playback.Controls
    $ok = $false

    if ($command -eq 'playPause') {
      if ([bool]$controls.IsPlayPauseToggleEnabled) {
        $ok = Await-Result ($session.TryTogglePlayPauseAsync()) ([bool])
      } elseif ([string]$playback.PlaybackStatus -eq 'Playing' -and [bool]$controls.IsPauseEnabled) {
        $ok = Await-Result ($session.TryPauseAsync()) ([bool])
      } elseif ([bool]$controls.IsPlayEnabled) {
        $ok = Await-Result ($session.TryPlayAsync()) ([bool])
      }
    } elseif ($command -eq 'play') {
      if ([bool]$controls.IsPlayEnabled) { $ok = Await-Result ($session.TryPlayAsync()) ([bool]) }
    } elseif ($command -eq 'pause') {
      if ([bool]$controls.IsPauseEnabled) { $ok = Await-Result ($session.TryPauseAsync()) ([bool]) }
    } elseif ($command -eq 'next') {
      if ([bool]$controls.IsNextEnabled) { $ok = Await-Result ($session.TrySkipNextAsync()) ([bool]) }
    } elseif ($command -eq 'previous') {
      if ([bool]$controls.IsPreviousEnabled) { $ok = Await-Result ($session.TrySkipPreviousAsync()) ([bool]) }
    } elseif ($command -eq 'seek') {
      if ([bool]$controls.IsPlaybackPositionEnabled) {
        $timeline = $session.GetTimelineProperties()
        $durationSeconds = [Math]::Max(0.0, [double]$timeline.EndTime.TotalSeconds - [double]$timeline.StartTime.TotalSeconds)
        $requested = 0.0
        try { $requested = [double]$payload.positionSeconds } catch {}
        $requested = [Math]::Max(0.0, [Math]::Min($durationSeconds, $requested))
        $ticks = [int64]($timeline.StartTime.Ticks + [Math]::Round($requested * 10000000.0))
        $ok = Await-Result ($session.TryChangePlaybackPositionAsync($ticks)) ([bool])
      }
    } else {
      Write-JsonLine @{ type = 'response'; id = $id; ok = $false; error = 'unsupported-command' }
      return
    }

    Write-JsonLine @{ type = 'response'; id = $id; ok = [bool]$ok }

    # Immediately reading GSMTC after Next/Previous or Seek can expose a
    # transient/stale timeline. Let the fast poll below provide the next
    # authoritative sample. The renderer keeps an optimistic seek position
    # until GSMTC acknowledges it.
    if ($command -ne 'next' -and $command -ne 'previous' -and $command -ne 'seek') {
      Start-Sleep -Milliseconds 35
      Emit-State $true $false
    }
  } catch {
    Write-JsonLine @{ type = 'response'; id = $id; ok = $false; error = [string]$_.Exception.Message }
  }
}

function Shutdown-Service {
  $script:shuttingDown = $true
  Clear-SessionSubscriptions
  Clear-ManagerSubscriptions
}

try {
  Initialize-Manager
  $readTask = [Console]::In.ReadLineAsync()
  $lastHeartbeat = [DateTimeOffset]::UtcNow

  while (-not $script:shuttingDown) {
    # Register-ObjectEvent queues WinRT events in this PowerShell process.
    # Drain/coalesce the queue every ~75 ms so rapid metadata + timeline
    # changes become one coherent state update rather than a burst of IPC.
    $queuedEvents = @(Get-Event)
    if ($queuedEvents.Count -gt 0) {
      $managerChanged = $false
      $sessionChanged = $false
      $mediaPropertiesChanged = $false
      foreach ($event in $queuedEvents) {
        $source = [string]$event.SourceIdentifier
        if ($source -eq 'gsm-manager-current' -or $source -eq 'gsm-manager-sessions') {
          $managerChanged = $true
        } elseif ($source -like 'gsm-session-*') {
          $sessionChanged = $true
          if ($source -like '*MediaPropertiesChanged*') { $mediaPropertiesChanged = $true }
        }
        try { Remove-Event -EventIdentifier $event.EventIdentifier -ErrorAction SilentlyContinue } catch {}
      }
      if ($managerChanged) { Refresh-SessionSubscriptions }
      if ($managerChanged -or $sessionChanged) {
        Emit-State $managerChanged $mediaPropertiesChanged
      }
    }

    if ($readTask.IsCompleted) {
      $line = $readTask.Result
      if ($null -eq $line) { break }
      if (-not [string]::IsNullOrWhiteSpace($line)) {
        try {
          $message = $line | ConvertFrom-Json
          if ([string]$message.type -eq 'command') {
            Execute-Command $message
          } elseif ([string]$message.type -eq 'refresh') {
            if ($message.reacquire -eq $true) {
              Reacquire-Manager
            } else {
              Refresh-SessionSubscriptions
              Emit-State $true $false
            }
          } elseif ([string]$message.type -eq 'shutdown') {
            break
          }
        } catch {
          Write-Diagnostic 'warn' ("invalid-command-json: " + [string]$_.Exception.Message)
        }
      }
      $readTask = [Console]::In.ReadLineAsync()
    }

    # WinRT events are still preferred, but Register-ObjectEvent cannot subscribe
    # reliably to these WinRT events on every PowerShell/Windows combination.
    # A lightweight 350 ms GSMTC poll keeps the bridge dependable without touching
    # audio levels, window titles or service-specific APIs. The renderer still
    # interpolates progress locally, so this is nowhere near a frame-rate poll.
    if (([DateTimeOffset]::UtcNow - $lastHeartbeat).TotalMilliseconds -ge 350) {
      Emit-State $false $false
      $lastHeartbeat = [DateTimeOffset]::UtcNow
    }

    Start-Sleep -Milliseconds 75
  }
} catch {
  Write-Diagnostic 'error' ([string]$_.Exception.Message)
  Write-JsonLine @{ type = 'state'; state = @{ available = $false; playing = $false; isPlaying = $false } }
} finally {
  Shutdown-Service
}
