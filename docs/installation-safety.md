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

L’installation et la mise à jour lisent le catalogue local de développement dans
le dépôt Lufa-AI ; elles n’ajoutent ni accès réseau ni cache.

## Extension étape 5 — inventaire et mises à jour

- `installed` et `outdated` lisent `lufa.lock.json`. Les écritures d’inventaire
  sont nulles. Les mises à jour sélectionnent uniquement la version stable la
  plus récente présente dans le catalogue local.
- `update` réutilise `.lufa.install.lock` : `install` et `update` d’un même
  projet attendent le même verrou (maximum 30 secondes). Après arrêt brutal,
  son retrait manuel reste conditionné à la vérification qu’aucune commande Lufa
  n’est active.
- Chaque chemin géré est contrôlé contre la destination de son identifiant ; les
  symlinks et entrées qui ne sont pas des fichiers/répertoires ordinaires sont
  refusés pendant l’inspection. Les fichiers absents du nouvel artefact sont des
  orphelins : ils ne sont ni remplacés ni supprimés et sont omis du lock mis à
  jour.
- Les SHA-256 du lock détectent les fichiers modifiés ou supprimés localement.
  Sans `--force`, tout conflit arrête l’opération avant écriture. Avec `--force`,
  le contenu local existant des fichiers concernés est sauvegardé avant leur
  remplacement sous `.lufa/backups/<transaction>/<chemin-relatif-projet>`. Les
  sauvegardes sont conservées même si une erreur ultérieure déclenche le
  rollback ; elles ne sont jamais nettoyées automatiquement.
- Les fichiers sont écrits par staging puis renommage/création exclusive ; le
  lock est remplacé en dernier. Une erreur ordinaire avant le commit du lock
  déclenche un rollback contrôlé par identité des fichiers écrits. Si le projet,
  un parent, un staging ou un fichier a une identité incertaine, le nettoyage
  correspondant est omis, l’élément est préservé et l’erreur signale les résidus
  possibles. Les fichiers orphelins et les sauvegardes ne sont pas rollbackés.
- Le rollback des fichiers et répertoires descend depuis la racine projet avec
  un CWD ancré, contrôle l’identité de chaque parent et son confinement avant
  chaque suppression, puis agit par nom relatif au répertoire ancré. Si un
  répertoire de skill a été déplacé hors projet ou remplacé par un symlink, aucun
  nettoyage n’est tenté à travers le nouveau chemin : le résidu déplacé est
  préservé, le rollback incomplet est signalé et le lock reste à sa version
  précédente. L’opérateur doit localiser/reconcilier manuellement ce résidu ; Lufa
  ne le supprime pas depuis son nouvel emplacement.
- **Limites :** le rollback n’est pas une transaction de système de fichiers
  atomique et n’est pas garanti face à un arrêt brutal, une panne système/disque,
  ni face à un processus tiers du même UID modifiant simultanément les mêmes
  chemins. Le verrou coordonne uniquement les commandes Lufa. Le comportement de
  CWD ancré documenté pour l’étape 4 reste validé sous Node 24/macOS seulement ;
  la portabilité et la résistance propre à chaque système restent à valider à
  l’étape 7. Les fichiers de sauvegarde peuvent contenir du contenu sensible du
  projet ; l’utilisateur est responsable de leur protection et de leur
  conservation.
