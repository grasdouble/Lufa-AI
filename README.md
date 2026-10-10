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
vérifie sans modifier les fichiers.

## Catalogue local

Les sources sont maintenues sous `catalog/<identifiant>/` : `artifact.json`
décrit l’artefact et ses versions, dont les chemins de fichiers sont relatifs à
ce dossier. Le contrat se trouve dans `schemas/artifact.schema.json`. L’index
`generated/catalog-index.json` est généré ; ne pas le modifier manuellement.

```sh
npm run catalog:validate # valide les sources
npm run catalog:build    # régénère l’index déterministe
npm run catalog:check    # valide les sources et vérifie la fraîcheur de l’index
```

Le niveau `declared` décrit une compatibilité annoncée ; `verified` exige une
preuve documentée et n’est pas déduit de la seule validation structurelle.
