# Octo-Sensei 🐙

> Le maître du dojo GitHub. Il ne fait pas de karaté, mais ses pull requests sont impeccables.

**Octo-Sensei** est un agent pour [Claude Code](https://claude.com/claude-code) spécialisé dans GitHub et git. Quand tu lui confies une tâche GitHub, Claude suit ses règles et ses « katas » au lieu d'improviser.

## Ce qu'il sait faire

| Kata | Exemple de demande |
|---|---|
| 🥋 Pull request propre | « Ouvre une PR pour mes changements » |
| 🔴 CI rouge | « Pourquoi ma CI est rouge ? Répare-la » |
| ⚔️ Conflit de fusion | « Ma PR a un conflit, règle-le » |
| 🔍 Revue de code | « Relis la PR #3 » |
| 🐛 Issues | « Écris une issue pour ce bug » |
| 🚀 Release | « Sors la version 1.0 avec l'APK » |
| 🧹 Dépôt bien rangé | « Mets en place la CI et les modèles sur ce dépôt » |

## Les règles du dojo

1. Jamais de force (`push --force`) sur la branche des autres.
2. Jamais directement sur `main` sans qu'on le demande.
3. Aucun secret dans git — et un secret qui a fuité se révoque.
4. Jamais tricher pour avoir une CI verte.
5. Rien d'irréversible sans accord.
6. Ce qu'on publie ne revient pas : pas de spam de commentaires.
7. Dire la vérité : « fait » veut dire vérifié.

Le détail est dans [`.claude/agents/octo-sensei.md`](.claude/agents/octo-sensei.md).

## L'installer

- **Dans un projet** : copie `.claude/agents/octo-sensei.md` dans le dossier `.claude/agents/` du projet. Tout le monde qui travaille sur ce projet avec Claude Code en profite.
- **Pour tous tes projets** : copie-le dans `~/.claude/agents/` sur ton ordinateur.
- **Dans une session Claude Code sur le web** : ajoute simplement ce dépôt à la session, l'agent est chargé automatiquement.

## L'utiliser

Demande-lui directement :

> Octo-Sensei, ouvre une PR propre pour mes changements.

ou laisse Claude le choisir tout seul : il le fait pour toute tâche GitHub ou git.

## Contribuer

1. Modifie l'agent sur une branche.
2. Vérifie : `python3 scripts/check_agents.py`
3. Ouvre une PR (le modèle te guide). La CI relance la vérification.
