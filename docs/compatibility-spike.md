# Spike de compatibilité — `.agents/skills/`

## Résultat

Le fixture isolé `tests/compatibility/fixture-project/.agents/skills/lufa-ai-compat-probe/SKILL.md` a été découvert et utilisé avec succès par les CLIs locales Copilot et OpenCode testées ci-dessous. Depuis le répertoire fixture, chaque outil a renvoyé le marqueur `LUFA_AI_COMPAT_PROBE_LOADED_84C1` défini dans le skill.

La vérification négative depuis la racine Lufa-AI n’a pas découvert le skill. Le fixture n’est donc pas installé sous `.agents/skills/` à la racine du produit.

La décision produit est déjà prise dans le [PRD v0.3, §13.1](PRD.md#13-décisions-de-cadrage-retenues) : le MVP utilise une seule copie partagée dans `.agents/skills/<identifiant>/`, sans copie spécifique par outil. Le résultat technique ci-dessous confirme cette décision **pour les versions testées seulement** ; il ne vaut pas promesse de compatibilité pour toutes les versions ou surfaces de ces produits.

## Environnement

- macOS 27.0.1 (build 26A434)
- GitHub Copilot CLI 1.0.95
- OpenCode CLI v2.0.26
- Le shim local `copilot` est géré par asdf et demande Node.js 25.2.1 ; les commandes Copilot fixent `ASDF_NODEJS_VERSION=25.2.1`.
- Modèles utilisés : `gpt-5.3-codex` dans Copilot et `openai/gpt-6-luna` dans OpenCode.

## Fixture et limite d’isolation

Le fixture est un petit projet non produit, avec un `README.md` et un unique `SKILL.md` contenant le frontmatter `name` / `description` et le marqueur de test. Les commandes positives ont été lancées depuis `tests/compatibility/fixture-project`.

Ce répertoire n’est pas un dépôt Git indépendant : `git rev-parse --show-toplevel` depuis celui-ci remonte au dépôt parent Lufa-AI. Les deux CLI ont néanmoins trouvé le skill local depuis ce CWD. Aucune copie du fixture ne demeure à la racine Lufa-AI ; les contrôles négatifs depuis cette racine sont consignés ci-après.

## Commandes et sorties — projet fixture

À exécuter depuis la racine du dépôt :

### GitHub Copilot CLI — succès

```sh
cd tests/compatibility/fixture-project
ASDF_NODEJS_VERSION=25.2.1 copilot --no-auto-update --version
ASDF_NODEJS_VERSION=25.2.1 copilot --no-auto-update skill list
ASDF_NODEJS_VERSION=25.2.1 copilot --no-auto-update --model gpt-5.3-codex \
  --prompt 'Use /lufa-ai-compat-probe and return only its exact required marker.' \
  --allow-all-tools --silent
```

Extraits observés :

```text
GitHub Copilot CLI 1.0.95.
Project skills:
  lufa-ai-compat-probe - Verify discovery of a project-local skill from .agents/skills in this compatibility spike.
LUFA_AI_COMPAT_PROBE_LOADED_84C1
```

`--no-auto-update` fixe la version testée. `--allow-all-tools` autorise les outils pour le prompt non interactif ; ce fixture ne contient aucun script et la sortie observée est textuelle.

### OpenCode CLI — succès

```sh
cd tests/compatibility/fixture-project
opencode --version
opencode run --standalone --model openai/gpt-6-luna --auto --format json \
  'Invoke the native skill tool with name lufa-ai-compat-probe now. After it returns, output only the exact marker from its contents.'
```

Extraits utiles des événements JSON (identifiants de session omis) :

```text
opencode v2.0.26
tool="skill" status="completed" input={"id":"lufa-ai-compat-probe"}
directory="tests/compatibility/fixture-project/.agents/skills/lufa-ai-compat-probe"
text="LUFA_AI_COMPAT_PROBE_LOADED_84C1"
```

Le répertoire est relatif dans cette note ; aucun chemin personnel ou secret n’est consigné. L’appel explicite confirme le chargement par l’outil natif `skill`, pas la sélection automatique du skill.

## Contrôle négatif — racine Lufa-AI

Copilot : `ASDF_NODEJS_VERSION=25.2.1 copilot --no-auto-update skill list`, exécuté depuis la racine, n’affiche que `Builtin skills:` et aucun skill de projet.

OpenCode : `opencode run --standalone --model openai/gpt-6-luna --auto --format json 'Try to invoke the native skill tool with name lufa-ai-compat-probe. If it is not available in this project, report that it is not available; do not read files or use other tools.'`, exécuté depuis la racine, retourne un événement `tool="skill" status="error"` (`Unable to load skill lufa-ai-compat-probe`) puis le texte `The native skill lufa-ai-compat-probe is not available in this project.` Le fichier `.agents/skills/lufa-ai-compat-probe/SKILL.md` n’existe pas à la racine.

## Sources officielles consultées (documentation, distincte du test)

- [GitHub Copilot CLI — Adding agent skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills) indique `.agents/skills` parmi les emplacements de skill projet et documente `copilot skill list` ainsi que l’invocation par `/nom-du-skill`.
- [GitHub Copilot — About agent skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills) mentionne `.agents/skills` parmi les emplacements de skills projet.
- [OpenCode — Agent Skills](https://opencode.ai/docs/skills/) indique `.agents/skills/<name>/SKILL.md` parmi les chemins projet reconnus et documente le chargement à la demande via l’outil `skill`.

Ces pages corroborent les résultats ; la compatibilité rapportée ici repose sur les commandes et sorties réellement exécutées.

## Limites

- Un seul environnement, une version de chaque CLI et un skill minimal ont été testés. Le résultat ne couvre pas la sélection automatique, les clients Copilot cloud/IDE, les versions futures ou d’autres systèmes d’agents.
- Le fixture est un sous-répertoire de test du dépôt, pas un dépôt Git indépendant ; les commandes ont bien été exécutées depuis son répertoire racine et le contrôle négatif depuis la racine du produit.
- La revue indépendante a conclu **prêt à valider**. Le coordinateur a accepté le résultat et marqué l’étape **Validée** ; voir le suivi d’implémentation.
