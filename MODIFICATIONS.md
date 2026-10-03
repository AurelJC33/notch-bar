# Calendar & Tasks polish — v3

- Removed the imported-calendar summary line (event count, iCal filename, timezone) from the calendar UI.
- Rebuilt the Tasks header so `Tasks`, `Today / Unscheduled / All`, open count and `+` never overlap or get clipped.
- Fixed persistence of unscheduled tasks: an empty date is now a valid state in the Electron store.
- New tasks are always created as `Unscheduled` with a 30-minute default duration and no date/time fields.
- Added `All` task filter with scheduled tasks sorted chronologically and unscheduled tasks after them.
- Duration editing moved out of the creation/edit form: click the duration chip on a task to open an inline MIN/SEC control directly below it.
- Improved drag-and-drop to Day view with a live dashed placement preview showing exact start time and duration.
- Added drag-to-Unscheduled support by dropping a task on the Unscheduled filter/list.
- Added direct top/bottom resize handles to scheduled Day-view tasks; resizing updates start/duration while preserving the opposite edge.
- Improved visual distinction between today's date and the selected date in Month view.
- Kept task creation/editing in the same inline component; no task side panel.
- Kept UI strings in English.

Validation: `npm run check` passes, including all 7 calendar/DST tests.

## v6 — System media companion notch

- Added a small cover bubble to the right of the notch whenever a Windows system media session is available.
- Clicking the cover expands a second horizontal media notch while smoothly shifting the primary notch so both surfaces remain centered as a group.
- Added system-wide Play/Pause, Previous, Next and seekable progress controls using Windows GSMTC through PowerShell/WinRT (no native Node addon required).
- Added title, artist/album, source application and album artwork support with a fallback media icon.
- The media surface remains available while paused so playback can be resumed from the notch.
- Added responsive sizing for the media panel when the large calendar view is open.
- Enlarged only the transparent Electron envelope so both notches can fit side by side; the visible calendar capsule remains at the compact 960×620 target.

## v7 — event-driven Windows GSMTC Now Playing

- Removed the old one-PowerShell-process-per-poll media detector.
- Added one persistent Windows GSMTC backend (`media-service.ps1`) and a Node bridge (`media-service.js`).
- The backend owns `GlobalSystemMediaTransportControlsSessionManager` and uses both `GetCurrentSession()` and `GetSessions()`.
- Active-session selection prefers actual Playing sessions, Windows' preferred session, the previously controlled source, then the most recently updated timeline.
- Added subscriptions for `CurrentSessionChanged`, `SessionsChanged`, `MediaPropertiesChanged`, `PlaybackInfoChanged`, and `TimelinePropertiesChanged`.
- Normalized one central media state for the renderer: title, artist, album, artwork, source app, status, timeline, capabilities and seek support.
- Artwork is cached and loaded only on track changes so cover IO never blocks the initial bubble.
- Progress now interpolates locally from Windows `Position + LastUpdatedTime`; no 16 ms Windows polling.
- Media commands are sent to the same persistent active session and capability-checked before play/pause, previous, next or seek.
- The bubble only first appears after a real Playing state, can remain visible while paused, and disappears when no Playing/Paused session remains.
- Added subtle artwork/title transition between tracks and a persistent diagnostic log at `media-service.log` in Electron's user-data directory.
- Added an MSIX/AppX `globalMediaControl` capability reference fragment for future packaged builds; the current build remains NSIS/unpackaged Win32.
- Added media-state unit tests; `npm run check` now runs 9 passing tests.


## v8 - GSMTC bridge visibility fix
- Media bubble visibility no longer depends on artwork or a renderer-only presentation flag.
- Main process re-sends cached media state on `did-finish-load` and refreshes GSMTC.
- Renderer performs a slow 2 s cache resync to recover from any missed startup IPC event.
- PowerShell GSMTC service falls back to a 900 ms state poll when WinRT event subscriptions are unavailable.
- Added state breadcrumbs to `media-service.log` without logging track metadata.

## v9 media stability / artwork
- Compact media bubble now matches the resting notch height (28 px).
- Added a transient GSMTC hand-off grace period so Next/Previous no longer hides the bubble while Windows briefly reports no eligible session.
- `Changing` sessions remain eligible and reuse the previous metadata during the short hand-off state.
- Artwork is no longer cached as permanently empty when the first thumbnail read is too early.
- GSMTC thumbnail retrieval retries for up to 10 sync cycles and prefers a WinRT-to-.NET stream bridge with DataReader fallback.
- Existing artwork stays visible briefly while the next track artwork is resolving, preventing a placeholder flash.
- Added non-sensitive artwork diagnostics (`artwork-loaded`, `artwork-thumbnail-missing`, read failures) to `media-service.log`.

## v10 — Stable track hand-off / refresh

- GSMTC fallback polling reduced from 900 ms to 350 ms because WinRT event subscription is not reliable on every Windows PowerShell setup.
- Next / Previous no longer force an immediate GSMTC state read during the transient no-session window.
- The Node media bridge keeps the last valid media state visible for up to 5 seconds during generic GSMTC gaps and up to 7 seconds after a manual Next / Previous command.
- Next / Previous trigger a short refresh burst (120 ms → 5 s) so the replacement session/track is discovered as soon as Windows publishes it.
- Repeated unavailable samples no longer extend the grace period forever.
- The renderer cache-resync timer can restore a valid state but can no longer hide the media notch from a transient stale cache sample.
- Existing artwork caching/transition logic is preserved.

## v11 — Seek feedback + continuous media rediscovery

- Seeking is now optimistic in the renderer: the progress thumb moves immediately and no longer snaps back when GSMTC briefly returns the pre-seek timeline.
- Stale post-seek timeline samples are ignored for up to 3 seconds, until Windows acknowledges the requested position.
- Seek triggers short native refresh samples after 120 / 360 / 800 / 1500 ms without forcing an immediate stale PowerShell read.
- Added an explicit `refresh-media-state` IPC path between renderer, Electron main and the persistent GSMTC service.
- When no media session is available, Electron now keeps probing once per second and requests a fresh GSMTC manager snapshot. This allows a newly started Deezer/Spotify/browser session to reappear after the previous media bubble has fully closed.
- Fresh manager acquisition is throttled and silent so failed WinRT event subscriptions do not flood `media-service.log`.
- While a session is already active, the existing lightweight 350 ms GSMTC state poll remains the primary refresh path.

Validation: `npm run check` passes with 9/9 tests. The Electron smoke test cannot run in the current Linux build environment because the Electron executable is not installed there.
## v12 — iCal multi-sources + accessoires audio

- Replaced the single stored calendar with a backward-compatible `calendarSources` collection (up to 20 sources), each carrying its own events, metadata and enabled state.
- Moved `.ics` import exclusively into Settings; the main Calendar view keeps only navigation and Month/Day controls.
- Enabled multiple calendars to render simultaneously; disabled sources are removed from the active event projection without deleting their stored data.
- Added rollback on persistence failures for calendar add/remove operations.
- Fixed GSMTC artwork retrieval robustness: validated image MIME/signatures, preserved the native `Thumbnail` source, and cached covers by source + album artist + album to avoid track-title collisions and needless duplicate reads.
- Audio connection notices now represent a real connection edge, use one 3,000 ms timeout, and restore an expanded media panel after the notice disappears.
- The accessory notification temporarily takes display priority over the expanded media surface, preventing overlap and blocking a conflicting re-expansion during the 3-second lifetime.
- Battery percentage now reads Windows PnP battery properties (`DEVPKEY_Bluetooth_BatteryLevel` / `DEVPKEY_Device_BatteryLevel`) with bounded related-device lookup and explicit unknown-state handling.
- Removed the previous fallback that treated any remembered Bluetooth headphone-like device as connected when no present audio endpoint existed.
- Added regression tests for multi-source browser behavior, 3-second media/accessory state arbitration, native battery/artwork code paths, and updated media identity.

Validation: `npm run check` passes with 17/17 tests. Full `npm run test:browser` was not executable in this Linux environment because the project does not contain an Electron runtime and `npm exec electron -- --version` could not complete.


## Calendrier — nom et couleur des sources
- Chaque source iCal possède désormais une couleur persistante, choisissable depuis Paramètres.
- Double-clic sur le nom d'une source pour la renommer inline ; Entrée valide, Échap annule.
- Les couleurs sont propagées aux événements issus de la source dans la vue calendrier.
- Les couleurs invalides/absentes reçoivent une couleur par défaut déterministe.

## v13 — correctifs ciblés (audit)

- **Pomodoro / Minuteur** : le temps restant est recalculé depuis une échéance absolue (`endAt`) au lieu d'un `remaining--` par tick. Plus de dérive après une mise en veille ou un tick retardé. Tick à 250 ms, rendu uniquement quand la seconde affichée change.
- **Presse-papiers** : les copies marquées sensibles par Windows (`ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory = 0`, utilisés par les gestionnaires de mots de passe) ne sont plus enregistrées. Nouveau réglage Paramètres > Privacy > « Clipboard history » (`clipboardHistoryEnabled`, activé par défaut) qui arrête complètement la capture.
- **Instance unique** : `app.requestSingleInstanceLock()` ; un second lancement quitte immédiatement (le notch existant est réaffiché si besoin).
- **media-service.log** : écritures asynchrones sérialisées (plus de `appendFileSync` sur le thread principal), rotation à 1 Mo vers `media-service.log.1`, et le « breadcrumb » d'état n'est écrit que lorsqu'il change.

### v13 — suite (smoke test + 1 bug trouvé en testant)

- **Bug corrigé** (`planner.js`, `addCalendarUrl`) : ajouter un calendrier par URL l'enregistrait **vide**. `setCalendarSources()` stocke des copies normalisées, mais la synchro remplissait l'objet d'origine (orphelin). Les événements n'apparaissaient qu'à la synchro automatique suivante (10 min) ou au redémarrage. La synchro vise maintenant l'objet réellement présent dans l'état.
- **tests/electron-smoke.cjs** remis à jour (il était périmé depuis la v12) : mocks des IPC presse-papiers et `fetch-ical-url`, sélecteur `#analytics-grid` (le sélecteur précédent comptait aussi le mois suivant : 61 au lieu de 31), taille de la vue Calendrier 960×620 (compactée en v5), mise à jour de la Shelf via `applyShelfData`, mesure de la zone cliquable Shelf en mode survol, import iCal par URL.

## v13 — effets sonores (identité sonore discrète)

- **Remplacement de `playBeep()`** (oscillateur unique à 880 Hz) par un petit moteur audio (`renderer/sound-engine.js`) : un `AudioContext` partagé, un `GainNode` maître pour le volume, sons décodés **une seule fois au démarrage**, anti-rebond de 80 ms par son.
- **7 sons courts (50–300 ms), même timbre** (sinus + harmonique discrète, attaque 4 ms, décroissance exponentielle), générés par `tools/generate-sounds.py` :
  - notifications : `reminder` (double ping), `connect` (Mi→Si, montant), `disconnect` (Si→Mi, descendant) ;
  - minuteurs : `timerDone` (Do-Mi-Sol), `pomoFocusEnd` (montant : pause méritée), `pomoBreakEnd` (descendant : retour au focus) ;
  - interface : `tick` (50 ms, niveau réduit), uniquement sur démarrer/pause (Pomodoro, Minuteur, Chronomètre, bouton pause compact).
- **Embarqués en base64** dans `renderer/sound-assets.js` (les `.wav` sources sont aussi dans `renderer/sounds/`) : la CSP (`connect-src` restreint) interdit `fetch`/XHR vers des fichiers locaux. Pour changer un son : modifier le script, relancer `python3 tools/generate-sounds.py`.
- **Réglages (Paramètres > Sound)** : interrupteur général `soundEnabled`, volume `soundVolume` (0–100, courbe quadratique, aperçu au relâchement), catégories `soundNotifications` (activé), `soundTimers` (activé), `soundUi` (**désactivé par défaut**), et `soundMuteWhenMedia` (« ne pas déranger » pendant la lecture média, désactivé par défaut). Les anciennes configurations sans ces clés héritent de ces valeurs.
- **Bluetooth** : le son de connexion part dans le même bloc que la notification (`justConnected`), donc jamais sur l'échantillon d'amorçage au démarrage ; le son de déconnexion utilise le front descendant symétrique (`justDisconnected`).
- **Rappels calendrier** : le son part quand le rappel s'affiche réellement (pas à la mise en file d'attente).
- `autoplayPolicy: 'no-user-gesture-required'` dans `main.js` pour que les alertes jouent même sans clic préalable depuis le lancement.
- Tests : `tests/sound-engine.test.mjs` (durées des assets, catégories, volume, ne-pas-déranger, contexte partagé, câblage Bluetooth/rappels) ; `npm run check` inclut `sound-engine.js`.
- Non fait : la détection d'un appel en cours (aucune API fiable côté renderer) ; seul le critère « lecture média active » est géré.

## v13 — distribution et mises à jour automatiques

- **`updater.js`** : enveloppe testable autour d'`electron-updater` (GitHub Releases). Vérification 30 s après le démarrage puis toutes les 6 h, téléchargement en arrière-plan, installation à la fermeture ou via « Restart to update ». Désactivé en développement (app non packagée). Pas de doublon de vérification pendant un téléchargement.
- **Paramètres > Updates** : interrupteur `autoUpdateEnabled` (activé par défaut), version courante, état (vérification, progression, prête, erreur) et bouton « Check now » / « Restart to update ». Un contrôle manuel fonctionne même si l'automatique est coupé.
- **IPC** : `get-update-state`, `check-for-updates`, `install-update`, évènement `update-state`.
- **`package.json`** : dépendance `electron-updater`, `build.publish` (GitHub, à renseigner), cible NSIS x64, script `npm run release`, `updater.js` ajouté aux fichiers packagés.
- **CI** : `.github/workflows/ci.yml` (`npm run check` à chaque push/PR) et `release.yml` (sur tag `v*` : vérifie tag = version, teste, construit, publie, signe si `CSC_LINK` est défini).
- Procédure complète dans `RELEASING.md`. Tests : `tests/updater.test.mjs`.
