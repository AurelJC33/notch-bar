# Publier une version (mises à jour automatiques)

L'app embarque `electron-updater` : elle vérifie GitHub Releases 30 s après le démarrage, puis toutes les 6 h. Quand une version plus récente existe, le notch s'agrandit (lueur courte + son discret) et affiche « Version x.y.z available — Click here to download and restart ». **Rien ne se télécharge sans clic** ; la croix repousse la mise à jour à plus tard (elle reste proposée dans Paramètres > Updates, et l'annonce revient au prochain lancement). Un clic télécharge la version depuis GitHub, installe en silence et relance Notch. Si un Pomodoro, un Timer ou un Stopwatch tournait, il reprend là où il en était (le temps restant est figé pendant le redémarrage).

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

## Tester le parcours sans publier de release
`NOTCH_FAKE_UPDATE=1` simule une version 9.9.9 : annonce, téléchargement (5 s) et redémarrage réel de l'app, avec reprise des minuteurs.
- PowerShell : `$env:NOTCH_FAKE_UPDATE=1; npm start`
- Lance un Pomodoro (ou un Timer / Stopwatch), attends la bannière (≈ 5 s), clique dessus : l'app redémarre et le minuteur repart du temps restant.
- Après le redémarrage de test la bannière revient (le faux updater annonce toujours 9.9.9) : c'est normal.

## Important : la première mise à jour vers 1.1.0
Les installations antérieures à 1.1.0 embarquent l'ancien updater (téléchargement automatique, installation à la fermeture ou via « Restart to update », sans bannière ni reprise des minuteurs). Le nouveau parcours s'applique donc **à partir des mises à jour qui suivent la 1.1.0**.
