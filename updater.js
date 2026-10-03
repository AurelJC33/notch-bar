'use strict';

/* Mises à jour automatiques (electron-updater + GitHub Releases).

   Le module est volontairement indépendant d'Electron : l'`autoUpdater`, le
   canal d'envoi vers le renderer et les minuteurs sont injectés, ce qui permet
   de le tester sans lancer l'app.

   Règles de sécurité d'usage pour un notch qui reste affiché en permanence :
   - le téléchargement se fait en arrière-plan, sans jamais redémarrer seul ;
   - la mise à jour s'installe à la fermeture de l'app (autoInstallOnAppQuit)
     ou quand l'utilisateur clique « Restart to update » ;
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
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.on('checking-for-update', () => publish({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => publish({ status: 'downloading', percent: 0, availableVersion: info && info.version || null }));
    autoUpdater.on('update-not-available', () => publish({ status: 'uptodate', percent: 0, availableVersion: null }));
    autoUpdater.on('download-progress', (progress) => publish({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(Number(progress && progress.percent) || 0))) }));
    autoUpdater.on('update-downloaded', (info) => publish({ status: 'downloaded', percent: 100, availableVersion: info && info.version || state.availableVersion }));
    autoUpdater.on('error', (error) => {
      log('[updater]', error && error.message ? error.message : String(error));
      publish({ status: 'error', error: 'Update check failed' });
    });
  }

  async function check({ manual = false } = {}) {
    if (!isPackaged || !autoUpdater) return state;
    if (!manual && !getAutoEnabled()) return state;
    if (state.status === 'checking' || state.status === 'downloading' || state.status === 'downloaded') return state;
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      // l'évènement 'error' a normalement déjà mis à jour l'état
      if (state.status !== 'error') publish({ status: 'error', error: 'Update check failed' });
    }
    return state;
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
    autoUpdater.quitAndInstall(false, true); // isSilent=false, isForceRunAfter=true
    return true;
  }

  return { start, stop, check, install, getState: () => state };
}

module.exports = { createUpdater, CHECK_DELAY_MS, CHECK_INTERVAL_MS };
