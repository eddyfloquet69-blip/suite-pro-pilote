# Revalo TPE — pilote applicatif 0.1

SaaS expérimental pour les TPE qui disposent de contrats de prestations récurrentes comportant une clause de révision de prix. Il ne propose pas de facturation électronique ni de modification automatique de contrats.

## Problème et promesse testée

Les entreprises de nettoyage, de maintenance, de services techniques et les prestataires B2B peuvent laisser passer une date de révision contractuelle, prolonger un prix devenu insuffisant et consacrer du temps à rechercher les indices et rédiger des courriers. **Le problème existe, mais la demande payante pour ce produit précis n'a pas encore été validée.**

Hypothèse initiale : un service à faible coût (prix à tester, pas affiché comme ferme) qui suit les échéances, calcule une révision sur la base de valeurs d'indice choisies dans le contrat, prépare un courrier et permet de distinguer montant potentiel et montant *déclaré* encaissé. Aucun montant calculé n'est présenté comme une vente ou une économie acquise.

## Fonctionnalités opérationnelles

- Comptes pilotes par email et mot de passe (invitation requise), sessions HTTP-only, stockage SQLite, isolation des enregistrements par utilisateur ;
- Contrats récurrents, prix mensuel, anniversaire, libellé de l'indice, lien de la source, valeurs de référence et actuelle, confirmation manuelle d'une clause ;
- Calculs `P_n=P_0*I_n/I_0` et `P_n=P_0*[f+(1-f)*I_n/I_0]` si et seulement si la formule est celle du contrat ;
- Gestion de l'avancement : préparée, demandée, acceptée, facturée, encaissée (déclarée, avec référence de paiement) ;
- Projet de courrier copiable, aucun envoi automatique, calendrier `.ics` exportable, export `CSV`, suppression de contrats ;
- Démonstration anonyme avec deux entreprises et des indices totalement fictifs.

## Installation locale

Prérequis : **Node.js 22.13 ou plus récent**.

```bash
cd revalo-tpe-v1
npm test
PILOT_CODE='un-code-prive-de-votre-choix' PORT=3000 npm start
```

Puis ouvrir `http://localhost:3000`. L'application crée `data/revalo.sqlite` dans le répertoire de travail. **Ne déployez jamais avec des codes de test ou des mots de passe publiés.** Pour l'interface de démonstration, cliquez sur « Voir l'exemple » ; aucun compte ni donnée serveur ne sont créés.

## Déploiement expérimental Railway

- Répertoire : racine du projet, commande : `npm start` ;
- Variables à créer : `PORT` fournie par Railway, `PILOT_CODE` secret long propre aux invitations, `DB_PATH=/data/revalo.sqlite`, `NODE_ENV=production` ;
- **Volume persistant** monté sur `/data`, sinon les données disparaîtront lors des redéploiements ;
- HTTPS activé sur le domaine Railway ; ne pas envoyer d'identifiants depuis un site en HTTP ;
- Vérifier les quotas et le plan de la plateforme. Un hébergement gratuit ne garantit pas la disponibilité ou la pérennité ;
- **Avant des données réelles de clients** : revue de sécurité, sauvegardes, politique de confidentialité et contrats de sous-traitance RGPD à compléter.

## Limites importantes

1. **Aucun indice n'est téléchargé automatiquement** à ce stade. C'est l'utilisateur qui sélectionne les valeurs correspondant *exactement* à sa clause et à sa période. Utiliser les données officielles INSEE ou du fournisseur d'indice applicable.
2. Les clauses, dates d'application, règles d'indexation et éventuelles réserves sont spécifiques aux contrats. Ce prototype ne remplace pas un conseil juridique ou un logiciel de facturation conforme.
3. Aucune facturation, intégration comptable, vérification bancaire ni envoi d'email automatique.
4. Les révisions marquées « encaissées » sont **déclarées par l'utilisateur**, non auditées. Un justificatif réel reste nécessaire avant d'annoncer un résultat.
5. Aucun renouvellement commercial n'est offert ; pas d'abonnement ni de paiement en ligne. La production continue nécessite audits, sauvegardes automatisées, monitoring, mentions légales et une politique de support.
6. N'utiliser que des exemples fictifs pour un essai public tant que les audits et démarches de conformité ne sont pas réalisés.

## Sources de référence métier

- INSEE, « Indexer un contrat » : https://www.insee.fr/fr/information/1300606
- Bpifrance Création, « Relations contractuelles et hausse du prix des matières premières » : https://bpifrance-creation.fr/encyclopedie/piloter-lentreprise/relations-commerciales/relations-contractuelles-hausse-du-prix
- API gratuite des indices Insee (future intégration possible) : https://www.insee.fr/fr/information/2862759

## Tests

- `npm test` : utilisateur A/B isolés, inscription, autorisation, protection origine, contrats, calculs, statut d'encaissement déclaré, exports, déconnexion.
- `python test/ui_e2e.py` : rendu bureau/mobile de l'interface fictive (aucune donnée client utilisée).