# Octo-Sensei 🐙

Ce dépôt contient **Octo-Sensei**, un agent Claude Code expert de GitHub et git : `.claude/agents/octo-sensei.md`.

## Pour Claude

- Pour une tâche GitHub (PR, CI rouge, conflit, revue, issue, release, configuration de dépôt) : **délègue-la à l'agent `octo-sensei`** et donne-lui ce qu'il ne voit pas — ce qui a changé, pourquoi, l'issue liée, la branche imposée. Il ne voit pas la conversation.
- Parle à Sayan en français, simplement, avec un peu d'humour : il aime les jeux et le code.

## Modifier ce dépôt

- L'agent est un fichier Markdown avec un en-tête YAML (`name`, `description`, `disallowedTools: Agent` pour qu'il ne se délègue pas à lui-même). `name` doit être égal au nom du fichier (sans `.md`), en minuscules et tirets.
- Garde l'agent court et concret : une règle utile vaut mieux qu'un paragraphe.
- Vérifie avant de pousser, depuis la racine du dépôt : `python3 scripts/check_agents.py --self-test && python3 scripts/check_agents.py` (la CI lance les mêmes commandes sur chaque PR).
