# Publier une version (mises à jour automatiques)

L'app embarque `electron-updater` : elle vérifie GitHub Releases 30 s après le démarrage, puis toutes les 6 h. La mise à jour se télécharge en arrière-plan et s'installe **à la fermeture** de l'app, ou via Paramètres > Updates > « Restart to update ». Rien ne redémarre tout seul.

## Réglage unique (une fois)
1. Dans `package.json`, section `build.publish`, remplace `VOTRE-PSEUDO-GITHUB` (et `notch-bar` si ton dépôt s'appelle autrement) par ton compte et ton dépôt.
2. Le dépôt doit être **public** (sinon `electron-updater` a besoin d'un token embarqué dans l'app : à éviter).
3. Dépôt GitHub > Settings > Actions > General > Workflow permissions : « Read and write permissions ».

## Chaque nouvelle version
1. Monte `version` dans `package.json` (ex. `1.0.1`). Les appareils comparent cette valeur : sans augmentation, aucune mise à jour n'est proposée.
2. `git commit`, puis `git tag v1.0.1 && git push origin main v1.0.1`.
3. Le workflow `Release` vérifie que le tag égale la version, lance `npm run check`, construit l'installeur NSIS et publie `latest.yml` + l'`.exe` dans GitHub Releases.
4. En local, sans CI : `GH_TOKEN=... npm run release`.

## Installer sur un autre appareil
Télécharge `Notch Bar Setup x.y.z.exe` depuis la page Releases. Les versions suivantes arrivent ensuite toutes seules.

## Signature du code
Sans certificat, l'installeur fonctionne et les mises à jour aussi, mais Windows SmartScreen affiche « éditeur inconnu » au premier lancement. Pour signer : achète un certificat de signature de code (ou utilise Azure Trusted Signing), puis ajoute dans les secrets du dépôt `CSC_LINK` (fichier `.pfx` en base64) et `CSC_KEY_PASSWORD`. Le workflow les passe à `electron-builder`, qui signe sans autre changement.

## Limites connues
- Non testé de bout en bout ici : il faut une vraie release publiée pour voir une mise à jour arriver.
- Pas de canal bêta (`allowPrerelease` est à `false`).
