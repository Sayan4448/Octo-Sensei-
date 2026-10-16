# Mon Orga 📋

Tâches, notes et agenda, sur téléphone Android et PC Windows (et Linux), synchronisés sur le même Wi-Fi.
Le mode d'emploi pour l'installer est dans le [README principal](../README.md#-mon-orga).

## Mode d'emploi express

- **Ajouter** : écris en bas, avec la date si tu veux. « Dentiste jeudi 14h30 », « Médicament tous les jours à 8h », « Courses ce soir », « Appeler Paul dans 2 h ». Sous le champ, l'app montre ce qu'elle a compris (une croix l'annule). Plusieurs lignes collées = plusieurs tâches.
- **Cocher** : touche le rond. Une erreur ? *Annuler* dans le bandeau. Une tâche qui se répète passe à sa prochaine date.
- **Reporter d'un geste** : appui long sur une tâche (clic droit ou touche M sur PC) → *Dans 1 h, Ce soir, Demain, +2 jours, +1 semaine*.
- **Phrases comprises** : « rappel 1 h avant », « alarme » (sonne comme un réveil), « ! » (importante), « 18h-1h » (rendez-vous de nuit), « EXP 03/27 » (fin du mois), « #Courses » (range dans la liste Courses si elle existe), une adresse « 12 rue… » devient le lieu.
- **Tout régler** : touche la tâche. Date et heure (ou boutons tout faits), rappels (à l'heure, 10 min avant, la veille…), *Sonner comme un réveil*, répétition, étapes, liste, détails, *Focus 25 min*.
- **En retard** : le bouton *Demain* reporte d'un jour ; *Tout à demain* reporte toutes les tâches en retard.
- **Notes** : la première ligne sert de titre. `- [ ]` fait une case à cocher (bouton *Case à cocher*), les liens, numéros et e-mails deviennent cliquables, une note peut avoir des photos et être épinglée.
- **Agenda** : touche un jour, puis *Rendez-vous*. Toute la journée ou à une heure, sur plusieurs jours, avec lieu, rappel, répétition et note liée. Supprimer une date d'une série : *Seulement le …*.
- **Rechercher** : la loupe cherche partout, accents ou pas.
- **Plus** : progrès, version PC, réglages des rappels (résumé du matin, relances, tout en mode réveil, nuit calme, tests), **Ma journée** (heure de « Demain » et « Ce soir », fin de journée, durée des rendez-vous, agenda du téléphone), sauvegarde (automatique dans un dossier, fusionner ou remplacer), affichage (thème, taille, langue, couleurs du téléphone, mode sobre, couleurs douces, gaucher), listes, verrou.
- **Avec un clavier** (PC, tablette) : `Ctrl+N` ajoute, `Ctrl+F` ou `/` cherche, `↑` `↓` passent d'une ligne à l'autre, `X` coche, `M` reporte, `Échap` ferme, `Alt+1…4` change d'onglet.

## Comment c'est fait

```
mon-orga/
├─ web/       l'interface (HTML, CSS, JavaScript sans dépendance), la même partout
│  ├─ src/    index.html, style.css, i18n.js (français, anglais), store.js (données, dates, rappels), host.js, app.js
│  └─ test/   tests du modèle, test de l'interface dans Chromium, cas partagés avec Android (fixtures.json)
├─ android/   l'appli Android (Kotlin) : affiche web/src dans une WebView et ajoute rappels, widget, raccourcis, verrou, serveur PC
├─ pc/        l'appli PC (Electron) : affiche web/src, garde les données dans un fichier, rappels Windows, synchro avec le téléphone
└─ docs/      captures d'écran du README
```

- **Données** : un seul document JSON (tâches, notes, rendez-vous, historique). Chaque élément a un `id` et une date de modification `updatedAt` : pour fusionner deux copies (téléphone, PC, sauvegarde), la plus récente gagne. Une suppression reste un mois comme « pierre tombale » pour se propager. Le format est décrit en tête de [`web/src/store.js`](web/src/store.js) ; Android le lit dans [`Store.kt`](android/src/main/kotlin/com/sayan/todo/Store.kt) sans toucher aux champs qu'il ne connaît pas.
- **Historique** : chaque coche ajoute `"heure:id"` à `history`, une coche annulée `"heure:id:x"` ; par jour et par tâche, la dernière entrée compte (série, niveau, graphique).
- **Rappels** : l'interface et Android calculent les mêmes dates (répétitions, rappels avant, journées entières à 9 h) ; les cas de [`web/test/fixtures.json`](web/test/fixtures.json) sont vérifiés des deux côtés. Android garde une seule alarme exacte, réglée sur le prochain rappel ; quand elle sonne, tout ce qui est dû depuis la dernière vérification sonne (les rappels manqués pendant que le téléphone était éteint aussi).
- **Synchro** : l'interrupteur *Ouvrir Mon Orga sur le PC* démarre un petit serveur sur le téléphone (port 8080). `/api/ping` répond à tout le monde (pour que le PC trouve le téléphone, avec la version du protocole `v`). L'appli PC parle à `/api/v2/sync` : clé = PBKDF2-SHA256(code, « mon-orga-sync-v2 », 100 000 tours), corps chiffrés en AES-256-GCM `{v, iv, data}`, horodatés et à usage unique ; le code ne circule jamais. Le mode navigateur garde `/api/state` et `/api/sync?k=code` (non chiffrés). 10 mauvais codes bloquent une minute, puis de plus en plus longtemps. L'appli PC envoie son document toutes les 15 secondes et après chaque modification, avec l'heure de la dernière synchro : une note modifiée des deux côtés depuis garde l'autre texte en copie « conflit » (`merge(local, remote, since)`, même règle en JS et en Kotlin, cas dans `fixtures.json`).

## Développer

| | Commande (depuis le dossier) |
|---|---|
| Interface : tests | `cd web && npm ci && npx playwright install chromium && TZ=Europe/Paris npm test` |
| Interface : l'essayer dans un navigateur | `cd web && node test/serve.js` puis http://127.0.0.1:8123 |
| Interface : refaire les captures | `cd web && npm run screenshots` |
| Android : tests et APK | `cd android && ./gradlew testDebugUnitTest assembleDebug` (JDK 21, `ANDROID_HOME`) → `build/outputs/apk/debug/MonOrga-debug.apk` ; l'APK publié vient de `assembleRelease` |
| PC : tests | `cd pc && npm ci && npm test` (sous Linux sans écran : `xvfb-run -a npm test`) |
| PC : lancer | `cd pc && npm start` |
| PC : fabriquer l'installateur Windows | `cd pc && npm run dist:win` → `dist/` |

L'APK est signé avec [`android/debug.keystore`](android/debug.keystore), gardé dans le dépôt : c'est ce qui permet d'installer chaque nouvelle version par-dessus la précédente.

## Publier une version

1. Mets à jour `versionCode`/`versionName` dans [`android/build.gradle.kts`](android/build.gradle.kts) et [`RELEASE_NOTES.md`](RELEASE_NOTES.md).
2. Lance le workflow [*Release*](../.github/workflows/release.yml) : sur GitHub, onglet **Actions** → **Release** → **Run workflow** (la version vient de `pc/package.json` si tu ne la tapes pas), ou pousse un tag `vX.Y.Z` sur `main`. Il construit l'APK, l'installateur et la version portable Windows, l'AppImage Linux, puis publie la release avec les notes.
