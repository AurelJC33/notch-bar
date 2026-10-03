'use strict';

/* Mises à jour (electron-updater + GitHub Releases).

   Le module est volontairement indépendant d'Electron : l'`autoUpdater`, le
   canal d'envoi vers le renderer et les minuteurs sont injectés, ce qui permet
   de le tester sans lancer l'app.

   Parcours (piloté par le notch, voir renderer/app.js) :
   1. vérification  -> état 'available' : RIEN n'est téléchargé, le notch annonce la version ;
   2. clic          -> download()       -> 'downloading' puis 'downloaded' ;
   3. le renderer fige l'état des minuteurs et appelle install() : l'app se ferme, l'installeur
      s'exécute en silence et relance Notch, qui reprend les minuteurs (voir resume-state.js).

   Règles pour un notch affiché en permanence :
   - aucun téléchargement ni installation sans clic de l'utilisateur ;
   - pas d'installation « à la fermeture » : elle contournerait la sauvegarde des minuteurs ;
   - aucune vérification en mode développement (app non packagée). */

const CHECK_DELAY_MS = 30 * 1000;            // on laisse l'app démarrer tranquillement
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // puis toutes les 6 h

function createUpdater({
  autoUpdater,
  isPackaged,
  version,
  getAutoEnabled,
  send = () => {},
  log = () => {},
  setTimeoutFn = setTimeout,
  setIntervalFn = setInterval,
  clearTimeoutFn = clearTimeout,
  clearIntervalFn = clearInterval,
}) {
  let state = { status: isPackaged ? 'idle' : 'disabled', version, percent: 0, availableVersion: null, error: null };
  let delayTimer = null;
  let intervalTimer = null;
  let started = false;

  function publish(patch) {
    state = { ...state, ...patch };
    send(state);
  }

  function attach() {
    if (!autoUpdater) return;
    autoUpdater.autoDownload = false;          // l'utilisateur décide (bannière du notch)
    autoUpdater.autoInstallOnAppQuit = false;  // jamais d'installation silencieuse à la fermeture
    autoUpdater.allowPrerelease = false;
    autoUpdater.on('checking-for-update', () => publish({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => publish({ status: 'available', percent: 0, error: null, availableVersion: info && info.version || null }));
    autoUpdater.on('update-not-available', () => publish({ status: 'uptodate', percent: 0, availableVersion: null }));
    autoUpdater.on('download-progress', (progress) => publish({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(Number(progress && progress.percent) || 0))) }));
    autoUpdater.on('update-downloaded', (info) => publish({ status: 'downloaded', percent: 100, availableVersion: info && info.version || state.availableVersion }));
    autoUpdater.on('error', (error) => {
      log('[updater]', error && error.message ? error.message : String(error));
      const duringDownload = state.status === 'downloading';
      // Un échec de téléchargement garde la version annoncée : on peut réessayer d'un clic.
      publish({
        status: 'error',
        error: duringDownload ? 'Update download failed' : 'Update check failed',
        availableVersion: duringDownload ? state.availableVersion : null,
      });
    });
  }

  async function check({ manual = false } = {}) {
    if (!isPackaged || !autoUpdater) return state;
    if (!manual && !getAutoEnabled()) return state;
    if (state.status === 'checking' || state.status === 'downloading' || state.status === 'downloaded') return state;
    // Une mise à jour attend déjà un clic : inutile de la re-chercher toutes les 6 h.
    if (!manual && state.status === 'available') return state;
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      // l'évènement 'error' a normalement déjà mis à jour l'état
      if (state.status !== 'error') publish({ status: 'error', error: 'Update check failed', availableVersion: null });
    }
    return state;
  }

  /* Lance le téléchargement (clic sur la bannière). Retourne false si rien à télécharger. */
  function download() {
    if (!isPackaged || !autoUpdater) return false;
    const retry = state.status === 'error' && !!state.availableVersion;
    if (state.status !== 'available' && !retry) return false;
    publish({ status: 'downloading', percent: 0, error: null });
    let pending;
    try { pending = autoUpdater.downloadUpdate(); } catch (error) { pending = Promise.reject(error); }
    Promise.resolve(pending)
      .catch((error) => {
        log('[updater]', error && error.message ? error.message : String(error));
        if (state.status !== 'error') publish({ status: 'error', error: 'Update download failed' });
      });
    return true;
  }

  function schedule() {
    clearTimeoutFn(delayTimer);
    clearIntervalFn(intervalTimer);
    delayTimer = setTimeoutFn(() => check(), CHECK_DELAY_MS);
    intervalTimer = setIntervalFn(() => check(), CHECK_INTERVAL_MS);
  }

  function start() {
    if (started || !isPackaged || !autoUpdater) return;
    started = true;
    attach();
    schedule();
  }

  function stop() {
    clearTimeoutFn(delayTimer);
    clearIntervalFn(intervalTimer);
    delayTimer = null;
    intervalTimer = null;
  }

  function install() {
    if (state.status !== 'downloaded' || !autoUpdater) return false;
    autoUpdater.quitAndInstall(true, true); // isSilent=true (pas de fenêtre d'installeur), isForceRunAfter=true (relance Notch)
    return true;
  }

  return { start, stop, check, download, install, getState: () => state };
}

module.exports = { createUpdater, CHECK_DELAY_MS, CHECK_INTERVAL_MS };
