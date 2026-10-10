# Lufa-AI

Catalogue d’artefacts pour agents IA, avec une première version centrée sur les skills.

- [PRD](docs/PRD.md)
- [Plan d’implémentation](docs/IMPLEMENTATION_PLAN.md)
- [Suivi d’implémentation](docs/IMPLEMENTATION_STATUS.md)

## Développement local

Prérequis : Node.js 24 ou ultérieur et npm. À la racine du dépôt :

```sh
npm ci
npm run format
npm run lint
npm run typecheck
npm test
npm run check
```

`npm run check` exécute les contrôles de formatage, lint, types et tests utilisés
par la CI. `npm run format` applique le formatage ; `npm run format:check` le
vérifie sans modifier les fichiers. Les tests de comportement du catalogue et de
la CLI seront ajoutés dans les étapes correspondantes du plan.
