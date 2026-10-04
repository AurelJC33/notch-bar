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

## v13 — repli automatique au clic en dehors du notch

- Le clic en dehors de la capsule traverse la fenêtre (clic-au-travers) : le renderer ne le reçoit jamais. `main.js` écoute donc l'évènement `blur` de la fenêtre (clic sur une autre app, le bureau, la barre des tâches, Alt+Tab) et envoie `window-blurred` au renderer.
- `collapseFromOutsideClick()` replie les modes ouverts (`expanded`, `schedule`, `analytics`, `analytics-expanded`, `settings`, `shelf`) et le panneau média étendu, vers `running` si un outil tourne, sinon `pill`. Les modes déjà compacts ne bougent pas.
- Garde-fous : aucun repli pendant un glisser vers la Shelf, ni pendant les 3 s qui suivent un glisser natif depuis la Shelf (`startDrag` peut faire perdre le focus un instant).
- Réglage Paramètres > Behavior > « Collapse on outside click » (`collapseOnOutsideClick`, activé par défaut).
- Limite : non testé avec Electron ici. Cas à vérifier à la main : Alt+Tab, clic sur la barre des tâches, glisser-déposer vers/depuis la Shelf.

## v1.1.0 — Mise à jour dans le notch + reprise des minuteurs

- Quand une version est disponible, la capsule s'agrandit avec une lueur courte (un tour de liseré + halo) et un son discret (`updateAvailable`, même timbre que « connect ») : « Version x.y.z available — Click here to download and restart ».
- Un clic télécharge la mise à jour GitHub (barre de progression dans la capsule), installe en silence et relance Notch. La croix en haut repousse à plus tard (Settings > Updates reste disponible).
- L'annonce ne coupe jamais une vue ouverte (Calendar, Settings, Shelf…) : elle attend le prochain retour à la vue compacte.
- `updater.js`: plus de téléchargement automatique ni d'installation à la fermeture ; nouvel état `available`, nouvelle action `download()`, retry après un échec de téléchargement.
- Nouveau `resume-state.js`: instantané validé des minuteurs (Pomodoro : phase, temps restant, cycle, session analytics ; Timer ; Stopwatch), écrit juste avant l'installation, relu une seule fois au redémarrage (10 min maximum) et supprimé aussitôt.
- Le temps restant est figé à l'instant de l'installation : la durée du redémarrage ne compte pas.
- Ajout de la classe CSS `.edge-accent` (le liseré « accent » des rappels calendrier n'avait pas de couleur définie).
- Test local sans release : `NOTCH_FAKE_UPDATE=1` (voir RELEASING.md).
- Tests : updater réécrit, nouveau `tests/resume-state.test.mjs` (validation, expiration, capture/restauration exécutées sur le vrai code du renderer).

## v14 — Visual identity: conic border glow, shadow cleanup, centered settings icon

- Replaced the SVG path + `requestAnimationFrame` edge light with a pure-CSS "animated border glow": two layers behind the notch surface (a sharp ring and a blurred glow), each driven by a rotating `conic-gradient`. `setEdge(color, kind)` keeps the same API (`spin` = rotating light, `pulse` = breathing contour) but only toggles classes now; color changes cross-fade through a registered `--edge-color` property.
- `#capsule` no longer clips its own content: background, rounded corners and `overflow:hidden` moved to the new `#capsule-surface`, so the glow can overflow around the shape. The ring is hidden along the top edge (the notch is flush with the screen).
- Removed every outer `box-shadow` / `drop-shadow` around the notch and the media companion. Cause of the grey, radius-less rectangle: the window is clipped by `setShape()` to a plain rectangle, so any shadow painted inside the rounded corners showed up as a grey square. The interactive region is now padded by `EDGE_GLOW_PAD` (24 px, sides and bottom) only while an edge glow is visible.
- Audio accessory (Bluetooth) green halo and update/reminder glows now go through the same edge system.
- Removed useless `will-change: width,height` on the capsule and `left,width,height` on the media notch.
- Incoming views now start 90 ms after the outgoing one begins to fade, so they no longer overlap during the size transition.
- Settings gear icon: the outline was centered on x = 12.9 while its inner circle and the button were centered on x = 12; the path is now centered.

## v15 — System tray icon and a way to quit

- Added a notification-area (tray) icon with an Open / Settings / Quit menu. Left click opens the notch. Open also re-centers the window and shows it again if it was hidden, so the app can always be found. The icon is embedded in main.js as base64 PNGs (16 px + 32 px for 200 % displays); nothing new to package.
- Added a "Quit Notch" button at the bottom of Settings. It asks for a second click to confirm, like "Reset settings", and warns when a timer is active.
- The tray icon is destroyed on quit so Windows does not keep a ghost icon.
- Launching the app a second time now opens the notch instead of only re-showing a hidden window.
- Settings opened from a compact state (tray, reminder, update banner) close back to the normal compact capsule.
- Added tests/tray-quit.test.mjs.

## v1.4.0 — Ergonomics

- The collapse button in the open view is now a chevron instead of a close cross, which was easy to read as "quit the app" (tooltip: "Collapse (Esc)").
- Escape now collapses the open view one layer at a time: Settings, then Shelf, then the expanded media notch, then the main view. It is ignored while a text field or a planner dialog (event, task editor) is open, since those handle Escape themselves.
- Timer: preset chips (5 / 10 / 15 / 25 / 45 min) and direct typing of the duration by clicking the time ("45", "5:30", "1:30:00", "90s"). Invalid input is outlined in red and Escape cancels. Parsing lives in `renderer/duration-input.js` (unit tested).
- Pomodoro: new Skip button (Reset | Skip | Start). Skipping a focus session records it as interrupted (it is not counted as completed) and goes to the short break; skipping a break goes back to focus. Skip never changes whether the timer is running.
- Added tests/ergonomics.test.mjs.

## v1.5.0 — Welcome, calendar empty state, settings order, global shortcut, auto-hide

- First-launch welcome: the capsule expands with four tips (hover, click, shortcut, tray icon). Stored apart from the settings (new `app-state` store) so "Reset settings" does not bring it back; existing installs are marked as seen. Replay it from Settings > Help > Welcome tour; `NOTCH_FORCE_WELCOME=1` forces it for testing.
- Calendar tab with no calendar: an "Add calendar" banner opens Settings scrolled to the Calendars group with the URL field focused.
- Settings regrouped by frequency of use: Pomodoro, Appearance, Behavior, Pinned pages, Calendars, Reminders, Sound, Privacy, Updates, Help.
- Global keyboard shortcut (default Ctrl+Alt+N) opens the notch or collapses it from any app; it can be disabled or changed in Behavior (click the key box, press the new combination). A combination refused by the OS is reported and the previous one is kept. Validation lives in `shortcut.js` (unit tested).
- Auto-hide notch (Behavior): the idle notch slides off-screen; pushing the mouse against the top of the screen for 50 ms brings it back. While hidden, only a 4 px strip at the top is interactive. It stays visible during timers, reminders, updates, Bluetooth notifications and any open view. The global shortcut and the tray icon also reveal it.
- Added tests/onboarding-autohide.test.mjs.

## v1.6.0 — Time page (Stopwatch + Timer) and Weather page

- Timer and Stopwatch are now one page, **Time**: a discreet Stopwatch / Timer switch at the top of the same bubble. Both views share one grid cell, so the notch never changes size and the content cross-fades. Every control keeps its id and behaviour (start, pause, resume, reset, presets, typed duration, steppers, background running, compact running pill, resume after an update). Switching the view does not touch a running tool; opening the page shows the tool that is running; the last view is remembered (`lastTimeMode`).
- Existing settings keep working: `timer` / `stopwatch` in `pinnedPages` and `lastTab` resolve to `time`. If both were pinned, the freed slot goes to Weather. Shortcuts: Ctrl+3 = Time, Ctrl+4 = Weather (Ctrl+1..6 follow the tab order).
- New **Weather** page in the existing tab system (same size as the other tabs, same open/close animations). It reproduces the weather bubble prototype: sky gradient that follows the hour of the day and the weather, sun / orbs / sheen, canvas effects (rain, snow, stars, fog, wind, lightning), glass hourly cards with icons, day switching with animated transitions, inertial horizontal scroll, "Today" shortcut, ← → keys. Layout recomposed for 380 × 320: left column (icon, temperature, condition) + right column (city, day switch, hourly cards).
- Data: the existing Open-Meteo request in `main.js` now also asks for hourly temperature / weather code / wind (2 past days + today + 5 days) in the **same single request**, and the city name comes from the existing IP geolocation providers. The page shows a small "Demo" tag and simulated data when no live forecast is available (offline, or Weather switched off in Settings > Privacy). To plug another API, return `{ source, city, days }` from `get-weather-forecast` (format documented in `renderer/weather-engine.js`).
- New `renderer/weather-engine.js` (pure functions shared by main, renderer and tests) and `renderer/weather.js` (DOM). The animation loop only runs while the page is visible and stops with Reduce motion.
- Tests: `tests/weather-engine.test.mjs`, `tests/time-weather-ui.test.mjs`; two existing assertions updated for the new default pinned pages and legacy tab ids.
