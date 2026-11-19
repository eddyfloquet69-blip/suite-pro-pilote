# Règles de sécurité — version pilote

- Le service ne doit accueillir **aucune donnée confidentielle de clients réels** tant qu'un audit technique/contractuel n'est pas effectué.
- Auth : mot de passe haché avec scrypt et sel aléatoire, cookie de session `HttpOnly`, `Secure`, `SameSite=Lax`, jeton aléatoire stocké sous empreinte SHA-256 ; session 10 jours.
- Accès à chaque contrat et chaque révision filtré par `user_id`. Pas de stockage de fichiers, de coordonnées bancaires ou de mots de passe en clair.
- Les requêtes mutantes sont limitées à l'origine du site et les tentatives de connexion/inscription limitées grossièrement par adresse IP. **Le rate limiting en mémoire n'est pas une protection exhaustive** en cas de multi-instances ou de redémarrage.
- Toute modification d'un compte nécessite une identification valide. La suppression d'un compte et de toutes ses données est disponible via l'API privée avec confirmation du mot de passe ; UI administrative à compléter.
- Les résultats calculés ne sont pas des encaissements constatés. La « référence paiement » déclarative peut être inventée, donc non fiable pour une communication commerciale sans vérification externe.
- Des sauvegardes PostgreSQL ou SQLite avec exercice de restauration, alertes et rétention contractuelle devront être mises en place avant le lancement réel.
- Une politique RGPD complète, mentions légales et registre des traitements restent à finaliser.