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
par la CI, dont la génération du site et les tests statiques de ses pages.
`npm run format` applique le formatage ; `npm run format:check` le vérifie sans
modifier les fichiers.

## Catalogue web local

Le site public en lecture seule est généré avec Astro dans `web/`. Il consomme le
même index que la CLI (`generated/catalog-index.json`) et les fichiers publiés
sous `catalog/` pour afficher leur contenu en texte consultable ; aucun contenu
n’est exécuté. Depuis la racine du dépôt :

```sh
npm run web:dev   # serveur de développement Astro
npm run web:build # génération statique dans web/dist/
```

La base est configurable avec `ASTRO_BASE` (par défaut `/`) ; pour simuler le
site GitHub Pages du dépôt :

```sh
ASTRO_BASE=/Lufa-AI npm run web:build
```

Le build exporte aussi le registre statique depuis les sources validées et
`generated/catalog-index.json`. L’index est servi à
`/Lufa-AI/registry/catalog-index.json` et les fichiers de skill à
`/Lufa-AI/registry/catalog/<identifiant>/<chemin-versionné>` (en local, retirer
le préfixe `/Lufa-AI`). Cet export est généré sous `web/public/registry/` et
n’est pas une seconde source de données.

Pour activer la publication, ouvrir **Settings → Pages** dans le dépôt et
choisir **GitHub Actions** comme source. Le workflow **GitHub Pages** n’a que
le déclencheur manuel `workflow_dispatch` : depuis l’onglet **Actions**, lancer
manuellement ce workflow pour publier le site à
`https://grasdouble.github.io/Lufa-AI/`. Aucun push ni déploiement n’est effectué
par les commandes locales.

`npm run check` reconstruit le site sans préfixe et sous `/Lufa-AI/`, puis vérifie
les routes, liens, assets et fichiers du registre publiés, les références
d’accessibilité de base ainsi que la recherche et l’état sans résultat.

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

Les commandes `list`, `search`, `show` et `outdated` rafraîchissent l’index du
registre statique, sans modifier le projet et sans envoyer de données du projet.
L’installation lit toujours les sources incluses du paquet : elle ne télécharge
pas d’artefact.

Le paquet npm prévu est provisoirement nommé `lufa-ai` (aucune publication n’a
été effectuée ; la disponibilité du nom peut évoluer). Pour compiler et créer un
tarball local :

```sh
npm run build
npm pack
```

Pour prévisualiser son installation dans un préfixe npm isolé, après `npm pack` :

```sh
npm install --prefix ./lufa-preview ./lufa-ai-0.1.0.tgz
cd ./lufa-preview
npm exec -- lufa list --json
npm exec -- lufa show hello-agent
npm exec -- lufa install hello-agent --yes --project ../lufa-preview-project
```

Le tarball contient le JavaScript compilé, le schéma, l’index et les sources de
catalogue nécessaires ; l’exécutable public est `lufa`. Pour tester le parcours
pack/install de bout en bout dans un répertoire temporaire, sans publier :

```sh
npm run pack:smoke
```

Depuis le dépôt, les commandes restent disponibles via npm :

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

L’URL par défaut de l’index est
`https://grasdouble.github.io/Lufa-AI/registry/catalog-index.json`. Pour le
développement et les tests, `LUFA_REGISTRY_URL` peut la remplacer par une URL
HTTPS personnalisée ; HTTP n’est permis que vers `localhost`, `127.0.0.0/8` ou
`::1`. Les redirections sont refusées. La CLI effectue une requête GET avec un
délai maximal de 3 secondes ; elle ne transmet ni chemin de projet, ni lock, ni
autre donnée projet. L’index
validé est mis en cache de façon atomique dans le cache utilisateur :
`$XDG_CACHE_HOME/lufa-ai` sous Linux (ou `~/.cache/lufa-ai`),
`~/Library/Caches/lufa-ai` sous macOS et `%LOCALAPPDATA%/lufa-ai/cache` sous
Windows. `LUFA_CACHE_DIR` permet de choisir un dossier de cache, notamment pour
les tests.

Chaque consultation indique sur `stderr` si l’index vient d’être rafraîchi. Si
le registre est indisponible ou invalide, la CLI utilise le dernier index en
cache, sinon l’instantané inclus au paquet ; un avertissement précise alors la
date du cache ou que l’instantané peut être périmé. Le cache symbolique ou de
plus de 5 Mio est ignoré. Ces messages ne polluent pas le JSON écrit sur
`stdout`.

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

## Inventaire et mises à jour

Depuis le dépôt Lufa-AI, utilisez `--project` pour cibler le projet consommateur
(sans cette option, le répertoire courant est utilisé) :

```sh
npm run lufa -- installed --project ../mon-projet
npm run lufa -- installed --project ../mon-projet --json
npm run lufa -- outdated --project ../mon-projet
npm run lufa -- outdated --project ../mon-projet --json
npm run lufa -- update --project ../mon-projet
npm run lufa -- update hello-agent --project ../mon-projet
npm run lufa -- update hello-agent --project ../mon-projet --yes
```

`installed` liste uniquement les entrées de `lufa.lock.json` (identifiant,
version exacte, cible et fichiers enregistrés). `outdated` compare chaque entrée
à la dernière version stable de l’index distant (ou du cache/instantané de
repli) et distingue `outdated`, `up-to-date` et `unavailable`. Les options
`--json` de ces commandes produisent des tableaux JSON sur `stdout`.

`update [identifiant]` (sans identifiant : toutes les entrées verrouillées)
affiche la provenance déclarée (dépôt), le chemin local du catalogue réellement
lu, les versions verrouillées/cibles, les ajouts, modifications et diffs, ainsi
que les fichiers retirés de la nouvelle version. Une mise à jour exige une
confirmation ; les scripts non interactifs doivent fournir `--yes` ou
`--non-interactive`. `update --json` fournit le plan JSON ; avec confirmation,
la sortie JSON inclut aussi `applied` et les notes de résultat. Les versions
cibles sont toujours stables ; il n’y a pas de sélection de préversion pour
`update`. Temporairement, `update` reste intégralement local au paquet et ne
consulte pas l’index distant ; le téléchargement des fichiers distants et la
mise à jour depuis ceux-ci sont reportés à la livraison 7.3b.

Avant toute écriture, les empreintes SHA-256 du lock sont comparées aux fichiers
locaux. Un fichier modifié ou supprimé bloque par défaut l’opération. Après
revue du diff, `--force` autorise le remplacement et sauvegarde chaque fichier
local existant concerné sous `.lufa/backups/<transaction>/<chemin-du-projet>`
(par exemple `.lufa/backups/<transaction>/.agents/skills/hello-agent/SKILL.md`).
Ces sauvegardes ne sont pas supprimées automatiquement. Un fichier devenu
orphelin reste à sa place, est signalé et cesse d’être géré dans le nouveau lock ;
aucune mise à jour ne le supprime automatiquement. Le contenu du catalogue n’est
jamais exécuté.

Les commandes `install` et `update` partagent `.lufa.install.lock` par projet.
Les écritures multi-fichiers sont compensées en cas d’erreur ordinaire avant le
commit du lock, mais ne forment pas une transaction atomique vis-à-vis des autres
processus et ne sont pas garanties contre un arrêt brutal, une panne disque ou
un processus tiers du même UID intervenant au même instant. Lorsqu’une identité
ou un emplacement devient incertain, Lufa échoue et préserve les résidus au lieu
de les supprimer à l’aveugle. Voir [les limites de sécurité](docs/installation-safety.md).
