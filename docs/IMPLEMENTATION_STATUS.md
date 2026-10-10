# Suivi d’implémentation — Catalogue Lufa AI

Le [plan d’implémentation](IMPLEMENTATION_PLAN.md) décrit les étapes et leurs critères de sortie. Ce fichier suit leur avancement réel ; il est mis à jour au fil du travail et versionné avec le dépôt.

## États

- **À faire** — le travail n’a pas commencé.
- **En cours** — l’étape est en développement.
- **À valider** — le travail et les vérifications sont terminés ; revue produit attendue.
- **Validée** — le résultat a été revu et accepté ; l’étape suivante peut commencer.
- **Bloquée** — une décision ou un problème empêche de poursuivre ; préciser le blocage.

On ne considère pas une étape comme validée uniquement parce que son code est terminé : les critères de sortie du plan doivent être vérifiés et le résultat revu.

## Vue d’ensemble

| Étape | Sujet | État | Résultat / blocage |
|---|---|---|---|
| 0 | Spike de compatibilité `.agents/skills/` | À faire | — |
| 1 | Décisions techniques et socle du dépôt | À faire | — |
| 2 | Contrat et premier catalogue valide | À faire | — |
| 3 | CLI de consultation du catalogue | À faire | — |
| 4 | Installation initiale et verrouillage | À faire | — |
| 5 | Inventaire et mises à jour sûres | À faire | — |
| 6 | Catalogue web en lecture seule | À faire | — |
| 7 | Publication, cache et portabilité | À faire | — |
| 8 | Pilote et décision de lancement | À faire | — |

**Étape suivante :** étape 0 — Spike de compatibilité `.agents/skills/`.

## Journal des validations

Ajouter une entrée lorsqu’une étape passe à **À valider**, puis compléter sa validation après revue.

### Étape 0 — Spike de compatibilité `.agents/skills/`

- **État :** À faire
- **Résumé / livrable :** —
- **Environnements et versions testés :** —
- **Vérifications effectuées :** —
- **Décision / points à corriger :** —
- **Validation utilisateur :** en attente

### Étape 1 — Décisions techniques et socle du dépôt

- **État :** À faire
- **Résumé / livrable :** —
- **Vérifications effectuées :** —
- **Décision / points à corriger :** —
- **Validation utilisateur :** en attente

### Étape 2 — Contrat et premier catalogue valide

- **État :** À faire
- **Résumé / livrable :** —
- **Vérifications effectuées :** —
- **Décision / points à corriger :** —
- **Validation utilisateur :** en attente

### Étape 3 — CLI de consultation du catalogue

- **État :** À faire
- **Résumé / livrable :** —
- **Vérifications effectuées :** —
- **Décision / points à corriger :** —
- **Validation utilisateur :** en attente

### Étape 4 — Installation initiale et verrouillage

- **État :** À faire
- **Résumé / livrable :** —
- **Vérifications effectuées :** —
- **Décision / points à corriger :** —
- **Validation utilisateur :** en attente

### Étape 5 — Inventaire et mises à jour sûres

- **État :** À faire
- **Résumé / livrable :** —
- **Vérifications effectuées :** —
- **Décision / points à corriger :** —
- **Validation utilisateur :** en attente

### Étape 6 — Catalogue web en lecture seule

- **État :** À faire
- **Résumé / livrable :** —
- **Vérifications effectuées :** —
- **Décision / points à corriger :** —
- **Validation utilisateur :** en attente

### Étape 7 — Publication, cache et portabilité

- **État :** À faire
- **Résumé / livrable :** —
- **Vérifications effectuées :** —
- **Décision / points à corriger :** —
- **Validation utilisateur :** en attente

### Étape 8 — Pilote et décision de lancement

- **État :** À faire
- **Résumé / livrable :** —
- **Vérifications effectuées :** —
- **Décision / points à corriger :** —
- **Validation utilisateur :** en attente

## Règle de mise à jour

1. Au démarrage d’une étape, passer son état à **En cours**.
2. Quand le livrable et ses vérifications sont prêts, renseigner son journal et passer à **À valider**.
3. Après revue, noter la décision et passer à **Validée**, ou laisser **À valider** en précisant les corrections attendues. Si un blocage empêche d’avancer, passer à **Bloquée** et le décrire.
4. Mettre à jour la ligne correspondante dans la vue d’ensemble et l’étape suivante uniquement après validation.

Garder une seule étape **En cours** à la fois. Les vérifications doivent indiquer ce qui a réellement été testé (commandes, plateformes ou versions pertinentes), et non uniquement « tests passés ».
