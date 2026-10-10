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

Les livraisons 7.3b ajoutent l’accès au registre et le cache de contenus pour
`install` et `update` ; le cache ne modifie pas le threat model projet décrit
ci-dessus.

## Index distant et cache — livraison 7.3a

- La consultation ne transmet aucune donnée du projet. Le cache d’index rejette
  les chemins de cache comportant des liens symboliques, les fichiers qui ne
  sont pas ordinaires et les caches dépassant 5 Mio ; l’écriture utilise un
  fichier temporaire puis un renommage atomique.
- Ces contrôles sont des vérifications au moment de l’opération, pas une garantie
  contre un processus tiers du même UID qui remplace un composant entre le
  contrôle et l’accès. Aucune protection contre ces courses n’est revendiquée.

## Contenus distants et cache — livraison 7.3b

- L’index versionné (schéma 2) publie le SHA-256 minuscule de chaque fichier.
  Le client refuse toute empreinte qui ne correspond pas à exactement 64
  caractères hexadécimaux minuscules.
- Les fichiers sont demandés sous le répertoire de l’endpoint d’index, après
  validation des chemins puis encodage de chaque segment. HTTPS est requis pour
  les hôtes distants ; HTTP reste réservé aux adresses loopback. Les redirections
  sont refusées. GitHub Pages et les hébergeurs statiques peuvent servir un
  fichier `.md` en `text/markdown` ou `text/plain` ; le client accepte aussi
  `application/octet-stream` pour un payload brut. Les paramètres MIME tels que
  `charset` sont ignorés. `text/html`, les autres types et un Content-Type absent
  sont refusés, même si le hash correspond, afin de ne pas prendre une page HTML
  d’erreur pour un artefact. Une réponse non-200, vide, expirée, trop grande ou
  dont le hash ne correspond pas arrête aussi la commande.
- Limites actuelles : 3 secondes par requête, 2 Mio par fichier et 10 Mio par
  artefact sélectionné (install ou chaque artefact d’update). Les réponses sont
  traitées comme des octets ; le hash est vérifié avant l’enregistrement du blob
  dans le cache ou toute écriture dans le projet.
- Les contenus validés sont indexés par hash dans
  `contents/sha256/<2 premiers caractères>/<sha256>`. Le cache refuse les
  symlinks, hardlinks, entrées non ordinaires, fichiers trop grands et contenus
  dont le hash ne correspond pas. Les écritures utilisent staging exclusif puis
  création de lien exclusive pour ne jamais remplacer un blob existant. Un blob
  exact peut être réutilisé avec un index en cache hors ligne ; l’instantané
  embarqué peut fournir des octets seulement si leur hash correspond à l’index
  résolu. Pour un artefact/version, tous les buffers distants sont accumulés en
  mémoire, puis toutes les empreintes et la limite totale sont contrôlées avant
  le premier nouveau blob cache. Un blob valide déjà présent reste intact si un
  autre fichier de l’artefact échoue.
- `install` vérifie les conflits de projet connus avant téléchargement. `update`
  ne télécharge aucun contenu si tout est à jour ou si un conflit connu bloque
  l’opération ; tous les contenus d’artefacts à mettre à jour sont vérifiés avant
  l’aperçu/apply et le lock restent gérés par la transaction existante. Une
  erreur de téléchargement/hash ne modifie aucun fichier projet ni lock.
- Comme pour le cache d’index, les vérifications de chemin et d’identité sont des
  contrôles ponctuels, pas une protection contre les courses d’un processus tiers
  du même UID. Cette limite est explicitement hors garantie ; les installations
  Lufa d’un projet restent sérialisées.

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
