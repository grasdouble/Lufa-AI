# Sécurité et limites de l’installation — étape 4

Cette note fixe le threat model accepté pour l’installation initiale. Elle ne
décrit pas encore les mises à jour, qui relèvent de l’étape 5.

- Le contenu du catalogue est non fiable et n’est jamais exécuté par
  l’installateur. Sa source est affichée avant confirmation.
- Les traversées de chemin et les symlinks présents aux emplacements vérifiés
  sont refusés. Pour les commits des fichiers de skill, les écritures utilisent
  un CWD ancré, contrôlé par `realpath('.')` avant et après chaque commit. Pour
  le lock, la racine projet est vérifiée avant le staging et le renommage
  atomique ; il n’y a pas de vérification postérieure du CWD après ce renommage.
- Les commandes d’installation Lufa d’un même projet sont sérialisées par
  `.lufa.install.lock`. Elles attendent au plus 30 secondes ; un verrou laissé
  par un arrêt brutal doit être supprimé manuellement, après vérification
  qu’aucune installation n’est encore active.
- Une erreur ordinaire pendant l’installation déclenche le rollback des fichiers
  créés par cette transaction ; l’installation ne doit pas être déclarée dans le
  verrou en cas d’échec. Le rollback retire un fichier uniquement si son
  identité correspond à celle créée par la transaction.
- **Limite du threat model :** la coordination concerne les processus Lufa ; il
  n’y a pas de garantie contre un autre processus du même UID qui modifie
  malicieusement les mêmes noms au même instant. Si l’identité ou l’emplacement
  du répertoire ancré ne permet pas un nettoyage sûr, la commande échoue avec un
  code non nul, signale les résidus possibles et les préserve au lieu de les
  supprimer à l’aveugle.
- Le parcours CWD ancré est vérifié sous Node.js 24 sur macOS seulement. Ne pas
  revendiquer cette garantie sur Linux ou Windows avant la validation de
  portabilité de l’étape 7.

L’installation actuelle lit le catalogue local de développement dans le dépôt
Lufa-AI ; elle n’ajoute ni accès réseau ni cache.
