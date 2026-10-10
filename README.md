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

## Consulter le catalogue

Les commandes de consultation lisent `generated/catalog-index.json` sans modifier
le projet. La CLI locale ne contacte aucun service et ne met rien en cache.
L’installation, elle, lit les sources du catalogue local de développement dans
`catalog/` : elle ne télécharge pas d’artefact et n’est pas encore une commande
distribuée. À cette étape, la CLI est utilisable depuis le dépôt, sans
installation de paquet ni commande `bin` :

```sh
npm run lufa -- list
npm run lufa -- search GREETING
npm run lufa -- show hello-agent
```

Pour une sortie JSON exploitable en pipeline, utilisez `--silent` afin que npm
n’ajoute pas ses bannières à `stdout` :

```sh
npm run --silent lufa -- list --json | jq '.[].id'
```

`search` effectue une recherche insensible à la casse dans les identifiants,
noms, descriptions, catégories et mots-clés. Ajoutez `--json` à `list`, `search`
ou `show` pour obtenir des objets JSON (tableau pour la liste et la recherche,
objet complet pour le détail). `show` expose notamment les versions et dates,
fichiers/destinations, niveaux et preuves de compatibilité, provenance,
prérequis et avertissements. `npm run lufa -- --help` affiche l’aide. Régénérez
l’index avec `npm run catalog:build` si celui-ci est absent ou invalide.

Le détail indique également `lufa install <identifiant>` comme commande
d’installation.

Démo du skill pilote :

```text
$ npm run lufa -- search WRITING
hello-agent  Hello Agent  Un skill pilote minimal qui aide à produire une réponse d’accueil claire et structurée.

$ npm run lufa -- show hello-agent
Hello Agent (hello-agent)
Type : skill
Description : Un skill pilote minimal qui aide à produire une réponse d’accueil claire et structurée.
...
Version 1.0.0 (publiée le 2026-10-10T00:00:00Z)
...
  github-copilot : declared
  opencode : declared
Prérequis : aucun
Avertissements : Compatibilité déclarée, non vérifiée pour ce skill pilote ; aucun résultat de test spécifique à cette version n'est disponible.
Installation : lufa install hello-agent
```

Le niveau `declared` décrit une compatibilité annoncée ; `verified` exige une
preuve documentée et n’est pas déduit de la seule validation structurelle.

## Installer un skill

Comme la CLI n’est pas encore distribuée, lancer ces commandes depuis le dépôt
Lufa-AI et indiquer le projet consommateur avec `--project` :

```sh
npm run lufa -- install hello-agent --project ../mon-projet
npm run lufa -- install hello-agent@1.0.0 --project ../mon-projet
```

Sans version, la CLI choisit la version stable la plus récente (jamais une
préversion implicite). Une version donnée, préversion comprise, peut être
sélectionnée explicitement. L’installateur affiche la source locale du catalogue,
la version, la destination et les fichiers, puis demande confirmation. En
automatisation, confirmer explicitement avec `--yes` ou `--non-interactive` :

```sh
npm run lufa -- install hello-agent --project ../mon-projet --yes
npm run lufa -- install hello-agent@1.0.0 --project /chemin/vers/projet --yes
```

Sans `--project`, la destination est le `process.cwd()` de la CLI.

Les fichiers sont installés sous `.agents/skills/<identifiant>/` et suivis avec
leurs empreintes dans `lufa.lock.json`. Une nouvelle installation présente un
aperçu et demande confirmation ; une réinstallation intacte est idempotente et
revient sans aperçu ni confirmation. Les automatisations doivent confirmer les
nouvelles installations avec `--yes`. La CLI lit le catalogue local de
développement, sans réseau ni cache. Les installations Lufa d’un même projet
sont sérialisées, mais cette coordination ne protège pas contre un processus
tiers du même UID qui modifie simultanément les mêmes chemins. Voir la [note de
sécurité et de threat model](docs/installation-safety.md) pour le rollback et les
limites de plateforme.
