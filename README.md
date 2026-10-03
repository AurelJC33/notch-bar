# Notch Bar (Emploi du temps / Pomodoro / Minuteur / Chronomètre)

## Installation
npm install
npm start

## Structure
- main.js        : fenêtre notch (frameless, transparente, toujours au-dessus),
                    fenêtre unique et responsive, persistance (electron-store).
- preload.js      : pont sécurisé (contextBridge) entre renderer et main
- renderer/
  - index.html/.css/.js : la capsule (Emploi du temps, Pomodoro, Minuteur, Chronomètre) ET le
    panneau de Réglages, qui est un état de plus de la même capsule
    (mode "settings") — une bulle qui s'agrandit depuis le notch, pas une
    fenêtre Electron à part.
  - calendar-engine.js : parsing iCalendar via la copie locale de `ical.js`,
    expansion des récurrences et normalisation timezone/DST.
  - planner.js : vues Mois/Jour, détails des événements et tâches CRUD.

## Canaux IPC
- set-ignore-mouse-events (send) : renderer -> main, pour le clic-au-travers
  hors de la capsule visible
- get-settings (invoke)    : lit les réglages (electron-store)
- save-settings (invoke)   : écrit les réglages (debounced côté renderer),
                             applique alwaysOnTop / démarrage auto
- reset-settings (invoke)  : réinitialise aux valeurs par défaut
- settings-updated (event) : main -> renderer notch, pour refléter un changement en direct
- get-planner-data / save-calendar-import / save-planner-tasks : API étroite
  vers un store `planner.json` distinct des réglages
- set-window-mode : bascule entre l'enveloppe notch compacte et l'espace de
  travail Emploi du temps, tous deux bornés au workArea de l'écran

## États de la capsule (tailles CSS, style.css)
- pill (repliée)       : 150 x 28
- hover                 : 210 x 28
- expanded (onglets)    : 380 x 320
- running (compact)     : 230 x 34, halo lumineux :
    - Pomodoro focus        -> orange, rotation continue
    - Pomodoro pause courte -> bleu, pulsation
    - Pomodoro pause longue -> vert, pulsation
    - Minuteur en cours     -> ambre, pulsation
    - Chronomètre en cours  -> gris neutre, pulsation
- settings (réglages)   : jusqu'à 380 x 540 (borné à 100vw/100vh), liste groupée façon iOS/macOS
  (interrupteurs, contrôle segmenté pour le thème, pastilles de couleur
  d'accent, steppers ronds pour les durées), avec défilement interne si le
  contenu dépasse. L'en-tête et le pied restent visibles.
- schedule (emploi du temps) : jusqu'à 1160 x 760, borné à la zone de travail;
  calendrier à gauche, tâches à droite, empilement responsive sous 800 px.

## Emploi du temps et import iCalendar

- Les calendriers `.ics` restent entièrement locaux : ils sont lus par `File.text()` dans
  le renderer puis normalisés; aucun fichier de calendrier n'est envoyé sur le réseau.
- Plusieurs sources iCalendar peuvent être ajoutées depuis Paramètres uniquement.
  Chaque source possède son propre nom, son état activé/désactivé et ses événements;
  toutes les sources activées sont fusionnées dans la vue Calendrier, sans ajouter de
  contrôles supplémentaires dans la page principale.
- `VTIMEZONE` est enregistré auprès d'`ical.js`. Les TZID IANA absents du
  fichier sont résolus avec `Intl.DateTimeFormat`, qui fournit les règles DST
  de la plateforme. Un événement flottant conserve l'heure écrite.
- Le fuseau d'affichage est `X-WR-TIMEZONE`, sinon le fuseau système.
- Les heures murales et le TZID d'origine restent stockés. Les dates ne sont
  donc pas converties naïvement en ISO UTC avant affichage.
- `RRULE`, `RDATE`, `EXDATE` et les exceptions reliées par `RECURRENCE-ID`
  passent par le moteur `ical.js`. L'expansion est bornée de janvier N-1 à
  janvier N+4, avec une garde de 5 000 occurrences par série.
- Chaque import ajoute une nouvelle source sans remplacer les précédentes. Le moteur
  continue de dédupliquer à l'intérieur d'un fichier par `UID + recurrenceId` stable;
  des sources distinctes restent distinctes lorsqu'elles publient le même UID.

Les tâches sont persistées séparément avec titre, notes, jour, heure facultative,
durée prévue, état terminé et timestamps. Elles n'ont aucun bouton Pomodoro.
Le bouton global « Lancer une session de Focus » appelle le Pomodoro existant.

## Vérification

```powershell
npm.cmd run check
npm.cmd run test:browser
npm.cmd run build
```

`npm test` couvre Europe/Paris en hiver et été, les deux changements DST, une
conversion UTC, les événements flottants, l'extraction professeur/salle et les
récurrences, ainsi que les chemins natifs batterie/artwork. Le smoke Electron vérifie
les 42 cellules Mois, les 24 heures Jour,
la création/complétion d'une tâche avec durée, la réutilisation du Focus et le
défilement des Paramètres à 380 x 420.


## Corrections apportées (v1.1)
- Suppression du rectangle translucide derrière la capsule : c'était l'ombre
  portée (box-shadow) qui se faisait couper net par une fenêtre exactement
  à la taille du contenu -> ombre retirée, backgroundColor alpha explicite
  ajouté (#00000000) pour une transparence Windows fiable.
- Le halo plein est remplacé par une fine ligne de lumière qui suit le bord
  de la capsule (technique de masque CSS "border en dégradé"), avec deux
  comportements distincts : rotation continue (focus Pomodoro, orange) ou
  pulsation (pause courte = bleu, pause longue = vert, minuteur = ambre,
  chronomètre = gris neutre).
- Le "décalage bizarre" à l'agrandissement/réduction est corrigé : le contenu
  est maintenant ancré en haut (position absolute, top:0) avec une hauteur
  fixe par état, au lieu d'être centré verticalement dans une boîte dont la
  hauteur changeait pendant l'animation -> plus de saut visuel, juste un
  fondu enchaîné (opacity) synchronisé avec le redimensionnement réel.
- Toutes les icônes emoji ont été remplacées par des icônes SVG dessinées à
  la main (traits fins, cohérentes avec le reste du design).
- Paramètres qui ne s'appliquaient pas, corrigés :
  - Durées Pomodoro (focus / pause courte / pause longue) : se répercutent
    maintenant immédiatement sur l'affichage au repos.
  - Thème (sombre/clair/auto) et couleur d'accent : réellement appliqués
    au rendu (variables CSS mises à jour en direct).
  - Réduire les animations : désactive à la fois le fondu de contenu et
    rend le redimensionnement de la fenêtre instantané (plus d'interpolation).
- Note : "Lancer au démarrage de Windows" utilise l'API Electron standard
  (app.setLoginItemSettings) ; son effet est fiable une fois l'app empaquetée
  (electron-builder) mais peut ne rien faire de visible en lancement via
  "npm start" (limitation connue d'Electron en mode développement).

## Corrections apportées (v1.2)
- La page Réglages n'est plus une fenêtre Electron séparée (qui s'affichait
  par-dessus tout, avec le titre générique "Electron") : c'est maintenant un
  nouvel état de la capsule elle-même ("mode-settings" dans style.css), donc
  une bulle qui grandit depuis le notch, au même endroit, avec le même style.
- Design entièrement repensé façon réglages iOS/macOS : listes groupées avec
  titres de section, interrupteurs animés, contrôle segmenté pour le thème,
  pastilles de couleur pour l'accent (avec coche sur la couleur active), et
  steppers ronds +/- pour les durées Pomodoro — plus aucun `<input>` brut de
  formulaire web, plus de titre "Paramètres — Notch Bar" façon fenêtre système.
- Chaque changement s'applique instantanément à l'affichage (aperçu en
  direct) et n'est écrit dans le stockage persistant qu'après un court
  debounce (250 ms), pour éviter de spammer le process principal quand on
  clique vite sur un stepper — plus réactif et plus optimisé.
- Réinitialisation à double confirmation intégrée à la bulle (pas de
  `confirm()` natif, qui aurait ouvert une boîte de dialogue disgracieuse
  dans une fenêtre transparente sans chrome).
- Fermeture par bouton dédié ou touche Échap, avec retour automatique au mode
  précédent (replié, survolé ou compact selon ce qui était actif avant
  d'ouvrir les réglages).
- Code mort supprimé : plus de fenêtre `settingsWin`, plus d'IPC
  `open-settings`/`close-settings`, plus de fichiers `settings.html/.css/.js`.

## Now Playing — Windows GSMTC service

The media feature now uses a persistent event-driven backend rather than
restarting PowerShell on a timer. See `MEDIA_ARCHITECTURE.md` for the full
flow and packaging notes.

If Now Playing does not initialize on a Windows machine, inspect
`media-service.log` in Electron's user-data folder. The log contains backend
initialization/event errors but does not intentionally log track metadata.

### Media reliability notes (v11)

The Now Playing bridge keeps checking for newly created GSMTC sessions even after
all media has stopped and the companion bubble has disappeared. When unavailable,
Electron requests a fresh GSMTC manager snapshot once per second; this is important
on Windows PowerShell installations where `SessionsChanged` cannot be subscribed to
reliably.

Seeking is optimistic: the slider updates immediately, then reconciles with the
next authoritative GSMTC timeline sample instead of jumping back to a stale
pre-seek position.
