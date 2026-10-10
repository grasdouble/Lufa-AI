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

| Étape | Sujet | État | Résultat / blocage |
|---|---|---|---|
| 0 | Spike de compatibilité `.agents/skills/` | Validée | Revue indépendante positive ; résultats bornés à Copilot CLI 1.0.95 et OpenCode CLI v2.0.26. |
| 1 | Décisions techniques et socle du dépôt | Validée | Revue indépendante positive ; job CI équivalent passé localement sous Node 24.20.0. CI distante non exécutée. |
| 2 | Contrat et premier catalogue valide | Validée | Revue indépendante positive ; schéma, sécurité des chemins, preuves et index déterministe couverts par 16 tests sous Node 24.20.0. |
| 3 | CLI de consultation du catalogue | À faire | — |
| 4 | Installation initiale et verrouillage | À faire | — |
| 5 | Inventaire et mises à jour sûres | À faire | — |
| 6 | Catalogue web en lecture seule | À faire | — |
| 7 | Publication, cache et portabilité | À faire | — |
| 8 | Pilote et décision de lancement | À faire | — |

**Dernière étape validée :** étape 2 — Contrat et premier catalogue valide.
**Prochaine étape :** étape 3 — CLI de consultation du catalogue.

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

- **État :** À faire
- **Résumé / livrable :** —
- **Vérifications effectuées :** —
- **Décision / points à corriger :** —
- **Validation finale :** en attente

### Étape 4 — Installation initiale et verrouillage

- **État :** À faire
- **Résumé / livrable :** —
- **Vérifications effectuées :** —
- **Décision / points à corriger :** —
- **Validation finale :** en attente

### Étape 5 — Inventaire et mises à jour sûres

- **État :** À faire
- **Résumé / livrable :** —
- **Vérifications effectuées :** —
- **Décision / points à corriger :** —
- **Validation finale :** en attente

### Étape 6 — Catalogue web en lecture seule

- **État :** À faire
- **Résumé / livrable :** —
- **Vérifications effectuées :** —
- **Décision / points à corriger :** —
- **Validation finale :** en attente

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
