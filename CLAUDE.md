# Octo-Sensei 🐙

Ce dépôt contient **Octo-Sensei**, un agent Claude Code expert de GitHub et git : `.claude/agents/octo-sensei.md`.

## Pour Claude

- Toute tâche GitHub ou git (pull request, CI GitHub Actions, conflit, revue, issue, release, configuration de dépôt) : **délègue-la à l'agent `octo-sensei`**.
- Parle à Sayan en français, simplement, avec un peu d'humour : il aime les jeux et le code.

## Modifier ce dépôt

- L'agent est un fichier Markdown avec un en-tête YAML (`name`, `description`). `name` doit être égal au nom du fichier (sans `.md`), en minuscules et tirets.
- Garde l'agent court et concret : une règle utile vaut mieux qu'un paragraphe.
- Vérifie avant de pousser : `python3 scripts/check_agents.py` (la CI lance la même chose sur chaque PR).
