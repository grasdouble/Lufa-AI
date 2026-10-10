# Suivi d’implémentation — Catalogue Lufa AI

Le [plan d’implémentation](IMPLEMENTATION_PLAN.md) décrit les étapes et leurs critères de sortie. Ce fichier suit leur avancement réel ; il est mis à jour au fil du travail et versionné avec le dépôt.

## États

- **À faire** — le travail n’a pas commencé.
- **En cours** — l’étape est en développement.
- **À valider** — le travail et les vérifications sont terminés ; revue indépendante attendue.
- **Validée** — le coordinateur a accepté le résultat après revue indépendante ; l’étape suivante peut commencer.
- **Bloquée** — une décision ou un problème empêche de poursuivre ; préciser le blocage.

On ne considère pas une étape comme validée uniquement parce que son code est terminé : les critères de sortie du plan doivent être vérifiés et le résultat revu.

## Vue d’ensemble

| Étape | Sujet                                    | État     | Résultat / blocage                                                                                                                 |
| ----- | ---------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Spike de compatibilité `.agents/skills/` | Validée  | Revue indépendante positive ; résultats bornés à Copilot CLI 1.0.95 et OpenCode CLI v2.0.26.                                       |
| 1     | Décisions techniques et socle du dépôt   | Validée  | Revue indépendante positive ; job CI équivalent passé localement sous Node 24.20.0. CI distante non exécutée.                      |
| 2     | Contrat et premier catalogue valide      | Validée  | Revue indépendante positive ; schéma, sécurité des chemins, preuves et index déterministe couverts par 16 tests sous Node 24.20.0. |
| 3     | CLI de consultation du catalogue         | Validée  | Revue indépendante positive ; 22 tests sous Node 24, JSON sans bruit npm et commande d’installation indicative documentés.         |
| 4     | Installation initiale et verrouillage    | Validée  | Revue indépendante positive dans le threat model borné ; 34 tests sous Node 24, protections testées sur macOS.                     |
| 5     | Inventaire et mises à jour sûres         | Validée | Revue indépendante positive ; 41 tests sous Node 24, conflits, backups, orphelins et rollback couverts.                           |
| 6     | Catalogue web en lecture seule           | Validée | Revue indépendante positive ; 46 tests, smoke HTTP, vérifications Chromium mobile/bureau et parcours clavier passés.                     |
| 7     | Publication, cache et portabilité        | À faire  | —                                                                                                                                  |
| 8     | Pilote et décision de lancement          | À faire  | —                                                                                                                                  |

**Dernière étape validée :** étape 6 — Catalogue web en lecture seule.
**Prochaine étape :** étape 7 — Publication, cache et portabilité.

## Journal des validations

Créer l’entrée d’une étape dès son démarrage et la tenir à jour pendant qu’elle est **En cours** ; compléter son résultat au passage à **À valider**, puis noter la décision après revue.

### Étape 0 — Spike de compatibilité `.agents/skills/`

- **État :** Validée
- **Résumé / livrable :** Fixture isolé et résultats consignés dans [le spike de compatibilité](compatibility-spike.md).
- **Environnements et versions testés :** macOS 27.0.1 (build 26A434), GitHub Copilot CLI 1.0.95 et OpenCode CLI v2.0.26.
- **Vérifications effectuées :** Depuis la racine fixture, Copilot `skill list` et invocation du skill avec marqueur attendu ; OpenCode appel de l’outil natif `skill`, contenu chargé et marqueur attendu. Depuis la racine Lufa-AI, aucun skill de projet listé par Copilot et chargement du skill en erreur dans OpenCode. Commandes et extraits dans la note.
- **Décision / points à corriger :** Le PRD v0.3, section 13, point 1, retient `.agents/skills/<identifiant>/` comme destination partagée sans copie spécifique par outil. Revue indépendante positive ; résultat borné à Copilot CLI 1.0.95 et OpenCode CLI v2.0.26. Aucun correctif bloquant identifié.
- **Validation finale :** validée par le coordinateur après revue indépendante.

### Étape 1 — Décisions techniques et socle du dépôt

- **État :** Validée
- **Résumé / livrable :** Comparaison des options et décisions consignées dans [ADR 0001](adr/0001-stack-and-repository-foundation.md) ; socle npm/TypeScript, commandes locales et CI GitHub Actions.
- **Vérifications effectuées :** `npm ci` puis `npm run check` sous Node.js 24.20.0 (mêmes commandes que le workflow CI ; format, ESLint, TypeScript et 1 test passés ; aucune vulnérabilité signalée) ; `git diff --check` (passé). La CI GitHub distante n’a pas été exécutée, aucun push n’ayant été fait.
- **Décision / points à corriger :** Revue indépendante positive et socle accepté. Confirmer avant l’étape 7 les cibles proposées de publication (paquet npm et GitHub Pages). Aucun artefact ou déploiement produit n’est créé à cette étape.
- **Validation finale :** validée par le coordinateur après revue indépendante et contrôles locaux sous Node 24.

### Étape 2 — Contrat et premier catalogue valide

- **État :** Validée
- **Résumé / livrable :** Schéma JSON, contenu pilote, validation automatique et index déterministe.
- **Vérifications effectuées :** `npm ci` puis `npm run check` sous Node.js 24.20.0 ; formatage, ESLint, TypeScript, validation du catalogue et de l’index déterministe, 16 tests passés ; 0 vulnérabilité signalée par `npm ci`. Les tests couvrent notamment les dates impossibles, les symlinks de racine et d’artefact, l’ordre ASCII / accentué et le rejet des preuves `verified` blanches.
- **Décision / points à corriger :** Type (`skill`) et environnements (`github-copilot`, `opencode`) sont distincts. Les compatibilités du pilote restent `declared` avec avertissement : le spike existant ne teste pas ce skill pilote. Les dates UTC sont validées comme dates calendaires réelles ; les racines et entrées catalogue symboliques sont rejetées explicitement. Les tris de l’index utilisent SemVer ou l’ordre Unicode par points de code, sans `localeCompare`. Les champs `testedVersion`, `method` et `reference` d’une preuve `verified` doivent contenir au moins un caractère non blanc ; les versions SemVer sont triées décroissantes ; sources et destinations refusent chemins absolus, traversées et séparateurs Windows, et les liens symboliques hors paquet sont rejetés. Aucune preuve de compatibilité propre au pilote n’a été ajoutée.
- **Validation finale :** validée par le coordinateur après revue indépendante.

### Étape 3 — CLI de consultation du catalogue

- **État :** Validée
- **Résumé / livrable :** Commandes locales `list`, `search` et `show`, y compris sortie JSON, consommant l’index généré sans écrire dans le projet courant.
- **Vérifications effectuées :** `ASDF_NODEJS_VERSION=24.20.0 asdf exec npm run check` sous Node.js 24.20.0 (format, lint, types, index valide et 22 tests passés) ; `git diff --check` ; démos de `list`, `search hello-agent`, `show hello-agent` et `show hello-agent --json` via le script npm.
- **Décision / points à corriger :** CLI limitée à la consultation locale ; aucun `bin`, distribution, installation effective, réseau, cache, web ou mutation de projet. `npm run --silent lufa -- list --json` fournit un JSON sans bannière npm ; `show` donne la commande d’installation à titre indicatif seulement, l’installation restant différée à l’étape 4.
- **Validation finale :** validée par le coordinateur après revue indépendante.

### Étape 4 — Installation initiale et verrouillage

- **État :** Validée
- **Résumé / livrable :** Commande install, aperçu/confirmation, installation idempotente et manifeste `lufa.lock.json`.
- **Vérifications effectuées :** `ASDF_NODEJS_VERSION=24.20.0 npm run check` (format, lint, types, catalogue et 34 tests passés) ; `git diff --check` passé. Tests déterministes de concurrence, de remplacement symlink avant écriture, de rollback après déplacement de l’ancre dans le projet et de refus de nettoyage si elle est déplacée hors projet ; aucun fichier dans le symlink externe ni lock mensonger, CWD restauré.
- **Décision / points à corriger :** Revue indépendante positive dans le threat model documenté : installations Lufa sérialisées ; pas de garantie contre un tiers du même UID modifiant malicieusement les mêmes noms simultanément. Si l’identité/emplacement est incertain, échec non-zéro et résidus signalés/préservés. CWD ancré vérifié sous Node 24/macOS uniquement ; Linux et Windows restent à tester à l’étape 7. Catalogue local seulement, pas de réseau/cache ; mises à jour reportées à l’étape 5.
- **Validation finale :** validée par le coordinateur après revue indépendante.

### Étape 5 — Inventaire et mises à jour sûres

- **État :** Validée
- **Résumé / livrable :** Commandes d’inventaire/outdated/update, aperçu, détection des conflits et sauvegarde forcée.
- **Vérifications effectuées :** `ASDF_NODEJS_VERSION=24.20.0 npm run check` (format, lint, types, index catalogue et 41 tests passés) ; `git diff --check` passé. Tests projet couvrant installed/outdated JSON, aperçu/diff, version à jour, conflits SHA-256, `--force` et backup, orphelin persistant, confirmation, rollback fichier+lock, lock fidèle, déplacement d’un répertoire de skill hors projet puis symlink (aucune suppression externe), provenance/source locale et sérialisation install/update.
- **Décision / points à corriger :** Revue indépendante positive. Threat model borné : verrou `.lufa.install.lock` partagé, chemins/symlinks inspectés et rollback par identité ; les résidus d’identité/emplacement incertains sont préservés et signalés. Pas de garantie face à un tiers du même UID, un arrêt brutal ou une panne disque ; les sauvegardes peuvent contenir des données sensibles, sont conservées même après rollback et doivent être gérées par le projet consommateur. Validation de portabilité limitée à Node 24/macOS pour le parcours CWD ancré de l’étape 4 ; Linux/Windows restent ouverts à l’étape 7.
- **Validation finale :** validée par le coordinateur après revue indépendante.

### Étape 6 — Catalogue web en lecture seule

- **État :** Validée
- **Résumé / livrable :** Site statique Astro sous `web/`, alimenté par `generated/catalog-index.json` et les fichiers catalogue ; recherche/filtres, pages de détail et commandes locales documentés.
- **Vérifications effectuées :** `ASDF_NODEJS_VERSION=24.20.0 npm run check` (format, lint, typecheck, index valide, build Astro, fixture de sécurité et smoke HTTP du build statique ; 46 tests au total) et `git diff --check` passés. Chromium : accueil à 390×844 et 1280×900, détail mobile sans débordement horizontal, clavier Tab vers skip-link/recherche/filtres, recherche sans résultat, Entrée sans rechargement, reset et navigation au détail ; aucune erreur JS. Le serveur Astro documenté répond HTTP 200 à l’accueil et au détail.
- **Décision / points à corriger :** Revue indépendante positive. Aucun déploiement, compte, administration ni édition/publication libre. La configuration `base` GitHub Pages reste ouverte à l’étape 7. Les erreurs de données bloquent la génération statique avec erreur exploitable plutôt que d’afficher une page runtime d’erreur.
- **Validation finale :** validée par le coordinateur après revue indépendante et contrôle navigateur.

### Étape 7 — Publication, cache et portabilité

- **État :** À faire
- **Résumé / livrable :** —
- **Vérifications effectuées :** —
- **Décision / points à corriger :** —
- **Validation finale :** en attente

### Étape 8 — Pilote et décision de lancement

- **État :** À faire
- **Résumé / livrable :** —
- **Vérifications effectuées :** —
- **Décision / points à corriger :** —
- **Validation finale :** en attente

## Règle de mise à jour

1. Au démarrage d’une étape, passer son état à **En cours** et créer son entrée de journal.
2. Quand le livrable et ses vérifications sont prêts, renseigner son journal et passer à **À valider**.
3. Après revue, noter la décision et passer à **Validée**, ou laisser **À valider** en précisant les corrections attendues. Si un blocage empêche d’avancer, passer à **Bloquée** et le décrire.
4. Mettre à jour la ligne correspondante dans la vue d’ensemble et l’étape suivante uniquement après validation.

Garder une seule étape **En cours** à la fois. Les vérifications doivent indiquer ce qui a réellement été testé (commandes, plateformes ou versions pertinentes), et non uniquement « tests passés ».
