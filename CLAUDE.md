# Octo-Sensei 🐙

Ce dépôt contient **Octo-Sensei**, un agent Claude Code expert de GitHub et git : `.claude/agents/octo-sensei.md`.

## Pour Claude

- Pour une tâche GitHub (PR, CI rouge, conflit, revue, issue, release, configuration de dépôt) : **délègue-la à l'agent `octo-sensei`** et donne-lui ce qu'il ne voit pas — ce qui a changé, pourquoi, l'issue liée, la branche imposée. Il ne voit pas la conversation.
- Parle à Sayan en français, simplement, avec un peu d'humour : il aime les jeux et le code.

## Mon Orga (`mon-orga/`)

L'app de Sayan : une seule interface web (`mon-orga/web/src`, sans dépendance) affichée par l'app Android (`mon-orga/android`, WebView + Kotlin pour rappels, widget, serveur PC) et par l'app PC (`mon-orga/pc`, Electron). Détails dans `mon-orga/README.md`.

- Avant de pousser : `cd mon-orga/web && TZ=Europe/Paris npm test`, `cd mon-orga/android && ./gradlew testDebugUnitTest assembleDebug` (JDK 21, `ANDROID_HOME` défini), `cd mon-orga/pc && npm test` (`xvfb-run -a` sans écran). La CI lance les mêmes.
- Une règle de dates ou de rappels change ? Elle existe en double (`web/src/store.js` et `android/.../Store.kt`) : change les deux et ajoute le cas dans `web/test/fixtures.json`, lu par les deux suites de tests.
- Publier : tag `vX.Y.Z` sur `main` → le workflow Release construit l'APK et les apps PC et crée la release. Les fichiers construits ne sont jamais commités. `android/debug.keystore` reste dans le dépôt : c'est lui qui permet d'installer une version par-dessus la précédente.

## Modifier ce dépôt

- L'agent est un fichier Markdown avec un en-tête YAML (`name`, `description`, `disallowedTools: Agent` pour qu'il ne se délègue pas à lui-même). `name` doit être égal au nom du fichier (sans `.md`), en minuscules et tirets.
- Garde l'agent court et concret : une règle utile vaut mieux qu'un paragraphe.
- Vérifie avant de pousser, depuis la racine du dépôt : `python3 scripts/check_agents.py --self-test && python3 scripts/check_agents.py` (la CI lance les mêmes commandes sur chaque PR).
