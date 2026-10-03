# Windows Now Playing architecture

The media integration is intentionally separated from the renderer:

`Windows GSMTC -> media-service.ps1 -> media-service.js -> Electron IPC -> renderer/app.js`

## Source of truth

`media-service.ps1` owns the Windows session manager and is the only component
that talks to `Windows.Media.Control`. It requests
`GlobalSystemMediaTransportControlsSessionManager`, reads both
`GetCurrentSession()` and `GetSessions()`, scores relevant Playing/Paused
sessions, subscribes to manager/session events, and emits one normalized state.

The renderer never detects Spotify, Deezer, browsers, window titles or audio
levels by itself.

## Events

The persistent service subscribes to:

- `CurrentSessionChanged`
- `SessionsChanged`
- `MediaPropertiesChanged`
- `PlaybackInfoChanged`
- `TimelinePropertiesChanged`

A 15-second resync exists only as a defensive fallback for buggy media apps;
the normal path is event-driven.

## Packaging / globalMediaControl

The current installer target is Electron Builder `nsis`, i.e. a classic
unpackaged Win32 desktop application. It does not have an AppX/MSIX package
manifest in which to declare package capabilities.

If the application is later shipped as MSIX/AppX, merge the capability fragment
in `windows/AppxManifest.media-capability.xml` into the package manifest:

`<uap7:Capability Name="globalMediaControl" />`

The helper requires Windows 10 version 1809 / build 17763 or newer, where GSMTC
was introduced.

## Commands

Commands are sent as JSON lines to the persistent helper and are capability
checked before execution: play/pause/toggle, previous, next, and seek.

Artwork is loaded only when the track changes and is cached, so thumbnail IO
does not block initial bubble display. Timeline animation is interpolated in
the renderer from Windows' `Position` + `LastUpdatedTime` reference rather than
polling Windows every animation frame.

## Track hand-off and artwork resilience
The media bridge treats GSMTC `Changing` and very short `available=false` states as transient hand-off states. The last valid media state remains visible for 1.8 seconds unless a new available state arrives first. Artwork is retried because desktop apps may publish title/artist before `Thumbnail`; empty first reads are never permanently cached.
