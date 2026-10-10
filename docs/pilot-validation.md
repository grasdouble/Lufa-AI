# Validation du pilote consommateur — étape 8

## Résultat

**Parcours réussi sur deux projets consommateurs temporaires isolés, sur macOS.** Le tarball local `lufa-ai@0.1.0` a été installé sans source du dépôt dans chacun des projets. Le registre public, le parcours installation → mise à jour, le cache hors ligne et la découverte du skill par les deux CLI ont été testés. Les empreintes SHA-256 des fichiers gérés correspondent au verrou ; le fichier devenu orphelin après mise à jour reste présent.

L’étape 8 est **Validée** après revue indépendante. Ce pilote ne déclenche pas de publication npm. Le MVP est prêt à être publié techniquement, mais le paquet public et son nom restent à confirmer avant toute action de publication.

## Versions et provenance

- Plateforme du pilote : macOS.
- Node.js utilisé pour le paquet et les commandes Lufa : **24.20.0** ; npm : **11.19.0**.
- GitHub Copilot CLI : **1.0.95** (shim local lancé avec Node.js 25.2.1).
- OpenCode CLI : **v2.0.26**.
- Paquet : `lufa-ai@0.1.0`, construit localement avec `npm pack` depuis le dépôt [grasdouble/Lufa-AI](https://github.com/grasdouble/Lufa-AI), commit **`57ca7a94646c5067144b68be65e653e967ac75b1`**. Tarball local : `lufa-ai-0.1.0.tgz` ; taille : 36,2 kB ; shasum npm : `9fdcceb6efa413f1c5781fe59f290cfa38d333b4`.
- Aucun URL de paquet npm publié : le tarball n’a été ni envoyé au registre npm ni rendu public.
- URL de registre testée : <https://grasdouble.github.io/Lufa-AI/registry/catalog-index.json> (URL par défaut de production). `curl` a reçu HTTP 200 et un document JSON de schéma 2 listant `hello-agent` et ses versions stables `1.2.0`, `1.1.0` et `1.0.0`.

## Parcours et preuves observées

Les deux projets et leurs caches Lufa étaient des répertoires séparés sous le dossier temporaire approuvé, hors du dépôt. Le binaire lancé était `node_modules/.bin/lufa` installé depuis le tarball ; la commande `list --json` a effectivement consulté le registre par défaut dans chaque projet.

### Projet A — installation et mise à jour

1. `lufa install hello-agent@1.1.0 --yes` a installé la version exacte et écrit `lufa.lock.json`.
2. `lufa outdated --json` a indiqué `lockedVersion: 1.1.0`, `latestStable: 1.2.0` et `availability: outdated`.
3. `lufa update hello-agent --yes` a appliqué `1.2.0`. L’aperçu et le résultat ont signalé `legacy-notes.md` comme orphelin conservé ; le fichier est toujours présent après la mise à jour et n’est plus dans la liste des fichiers gérés par le verrou `1.2.0`.
4. Vérification indépendante par Node.js : pour chacun des deux fichiers gérés en `1.2.0`, le SHA-256 calculé sur disque est identique à celui de `lufa.lock.json`. Un nouvel `outdated --json` indique `up-to-date`.

### Projet B — dernière stable et cache hors ligne

1. Sans version explicite, `lufa install hello-agent --yes` a choisi `1.2.0` et a enregistré deux fichiers avec leurs empreintes.
2. Après capture des versions, chemins et empreintes, l’URL du registre a été remplacée par `http://127.0.0.1:9/registry/catalog-index.json`, sans changer `LUFA_CACHE_DIR`. `curl` a confirmé le refus de connexion sur ce port loopback. `lufa outdated --json` a réussi depuis le cache et affiché explicitement : « registre indisponible … index du cache … potentiellement périmé ».
3. `lufa install hello-agent@1.2.0 --yes` avec la même URL loopback et le même cache a réussi avec « Déjà installé … (empreintes vérifiées) ». Une comparaison avant/après confirme la même version, le même ensemble de fichiers et les mêmes SHA-256, tous conformes au verrou ; le registre de production n’était pas configuré comme destination durant cette phase.

### Découverte par les CLI agents

- Depuis le projet A, `copilot --no-auto-update skill list` a affiché `Project skills: hello-agent` avec sa description.
- Depuis le projet B, OpenCode a reçu une demande d’invoquer explicitement son outil natif `skill` avec l’identifiant `hello-agent`. L’événement JSON confirme `tool="skill"`, `status="completed"` et l’identifiant demandé ; le contenu chargé et la réponse contenaient la phrase observable « When asked to greet or welcome someone ».
- Le chargement du modèle local configuré a réussi pendant ce test. Aucun secret ni identifiant de modèle n’est consigné. Le skill a été chargé par l’outil OpenCode ; son contenu n’a jamais été exécuté en shell.

## Commandes reproductibles

Les commandes ci-dessous sont une procédure reproductible, pas une nouvelle exécution du pilote. Elles conservent les preuves observées consignées plus haut ; leur clarification documentaire ne constitue pas une preuve supplémentaire. Copier et exécuter les blocs successivement dans le même shell, depuis la racine du dépôt, afin de conserver `PILOT_TMP` et son `trap` de nettoyage.

Depuis la racine du dépôt, avec Node.js 24.20.0 sélectionné, créer un dossier temporaire neuf et installer un nettoyage limité à ce dossier précis :

```sh
set -eu
PILOT_TMP="$(mktemp -d "${TMPDIR:-/tmp}/lufa-pilot.XXXXXX")"
trap 'rm -rf -- "$PILOT_TMP"' EXIT
mkdir -p "$PILOT_TMP/project-a" "$PILOT_TMP/project-b" \
  "$PILOT_TMP/cache-a" "$PILOT_TMP/cache-b"

ASDF_NODEJS_VERSION=24.20.0 asdf exec npm pack --pack-destination "$PILOT_TMP"
```

Sur macOS, `mktemp` utilise ainsi le `$TMPDIR` natif lorsqu’il est défini. Le tarball est créé par `npm pack` à la racine du dépôt. Les deux projets consommateurs l’installent ensuite depuis ce tarball ; aucune source du dépôt n’est nécessaire dans leurs répertoires. `LUFA_CACHE_DIR` pointe vers deux caches distincts, un par projet. Les commandes en ligne laissent `LUFA_REGISTRY_URL` non défini pour utiliser le registre par défaut. Si cette variable était déjà définie dans le shell, l’effacer avant de poursuivre :

```sh
unset LUFA_REGISTRY_URL

(
  cd "$PILOT_TMP/project-a"
  ASDF_NODEJS_VERSION=24.20.0 asdf exec npm install --no-save --ignore-scripts \
    --no-audit --no-fund "$PILOT_TMP/lufa-ai-0.1.0.tgz"
  LUFA_CACHE_DIR="$PILOT_TMP/cache-a" ./node_modules/.bin/lufa list --json
)

(
  cd "$PILOT_TMP/project-b"
  ASDF_NODEJS_VERSION=24.20.0 asdf exec npm install --no-save --ignore-scripts \
    --no-audit --no-fund "$PILOT_TMP/lufa-ai-0.1.0.tgz"
  LUFA_CACHE_DIR="$PILOT_TMP/cache-b" ./node_modules/.bin/lufa list --json
)
```

Créer une fois dans le dossier temporaire le script Node qui contrôle tous les SHA-256 déclarés par `installs[].files` dans le verrou du répertoire courant. Il lit les fichiers sous le CWD consommateur, rejette les chemins hors du projet et échoue avec un code non nul si un fichier manque ou si son empreinte diffère :

```sh
cat > "$PILOT_TMP/verify-lock.mjs" <<'NODE'
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const root = await realpath(process.cwd());
const lock = JSON.parse(await readFile(path.join(root, 'lufa.lock.json'), 'utf8'));
let checked = 0;

for (const install of lock.installs) {
  for (const file of install.files) {
    const filename = path.resolve(root, file.path);
    const relative = path.relative(root, filename);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Chemin hors du projet : ${file.path}`);
    }
    const actualFilename = await realpath(filename);
    const actualRelative = path.relative(root, actualFilename);
    if (
      actualRelative === '..' ||
      actualRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(actualRelative)
    ) {
      throw new Error(`Fichier hors du projet : ${file.path}`);
    }
    const actual = createHash('sha256')
      .update(await readFile(actualFilename))
      .digest('hex');
    if (actual !== file.sha256) {
      throw new Error(`SHA-256 différent pour ${file.path} : attendu ${file.sha256}, obtenu ${actual}`);
    }
    checked += 1;
  }
}

console.log(`${checked} empreinte(s) SHA-256 conforme(s) au verrou.`);
NODE
```

Parcours du projet A : le registre reste sur son URL par défaut en ligne. Vérifier les empreintes dans le CWD consommateur après la mise à jour :

```sh
(
  cd "$PILOT_TMP/project-a"
  LUFA_CACHE_DIR="$PILOT_TMP/cache-a" ./node_modules/.bin/lufa install hello-agent@1.1.0 --yes
  LUFA_CACHE_DIR="$PILOT_TMP/cache-a" ./node_modules/.bin/lufa outdated --json
  LUFA_CACHE_DIR="$PILOT_TMP/cache-a" ./node_modules/.bin/lufa update hello-agent --yes
  LUFA_CACHE_DIR="$PILOT_TMP/cache-a" ./node_modules/.bin/lufa outdated --json
  node "$PILOT_TMP/verify-lock.mjs"
)
```

Parcours du projet B : installer d’abord avec le registre par défaut en ligne, vérifier les empreintes, puis basculer vers une URL loopback inaccessible sans changer son cache. Le contrôle `curl` doit échouer (un succès interrompt le parcours) ; exécuter le vérificateur avant et après les commandes hors ligne pour comparer les empreintes au verrou :

```sh
OFFLINE_REGISTRY_URL=http://127.0.0.1:9/registry/catalog-index.json
(
  cd "$PILOT_TMP/project-b"
  LUFA_CACHE_DIR="$PILOT_TMP/cache-b" ./node_modules/.bin/lufa install hello-agent --yes
  node "$PILOT_TMP/verify-lock.mjs"

  if curl --fail --silent --show-error "$OFFLINE_REGISTRY_URL"; then
    echo 'Le registre loopback répond, ce test offline ne convient pas.' >&2
    exit 1
  fi
  LUFA_REGISTRY_URL="$OFFLINE_REGISTRY_URL" \
    LUFA_CACHE_DIR="$PILOT_TMP/cache-b" ./node_modules/.bin/lufa outdated --json
  LUFA_REGISTRY_URL="$OFFLINE_REGISTRY_URL" \
    LUFA_CACHE_DIR="$PILOT_TMP/cache-b" ./node_modules/.bin/lufa install hello-agent@1.2.0 --yes
  node "$PILOT_TMP/verify-lock.mjs"
)
```

Pour vérifier la découverte des CLI, lancer chaque commande depuis le projet consommateur correspondant. Renseigner pour OpenCode un modèle disponible sans consigner son identifiant dans les traces du pilote :

```sh
(
  cd "$PILOT_TMP/project-a"
  ASDF_NODEJS_VERSION=25.2.1 copilot --no-auto-update skill list
)

(
  cd "$PILOT_TMP/project-b"
  opencode run --standalone --model "$OPENCODE_MODEL" --auto --format json \
    'Use the native skill tool now, explicitly with the id "hello-agent". After that tool returns, output exactly the phrase "When asked to greet or welcome someone" from the skill content and nothing else.'
)
```

## Limites et décision

- Deux projets temporaires, une machine macOS, un artefact et les versions de CLI ci-dessus : ce résultat ne garantit pas la compatibilité avec les versions futures, d’autres systèmes, les clients IDE/cloud ou la découverte automatique par l’agent.
- Le test OpenCode confirme le chargement par son outil natif, pas l’exécution ni la qualité comportementale du skill.
- Le pilote utilise le tarball local non publié ; il ne valide pas l’installation depuis npm, un processus de publication, ni un déploiement.
- Les authentifications locales nécessaires aux CLI étaient disponibles ; aucune valeur de secret n’a été affichée ou enregistrée.
- Résultat : **parcours pilote favorable, étape 8 Validée après revue indépendante**. La publication npm et toute décision d’élargissement restent hors de ce pilote ; aucune action de publication n’a eu lieu.
