# Procédures obligatoires du projet Bizave

Ces règles s’appliquent à toute intervention dans ce projet. Les trois premières procédures doivent être suivies strictement et systématiquement afin d’éviter autant que possible le recours à la quatrième.

## 1. Modification du projet

Avant toute modification de code ou de fichier du projet :

1. Vérifier si un serveur Vite lié à ce projet est actif.
2. Après les tests, relance le, toujours sur le même port et accessible au réseau local

## 2. Build Vite

Avant chaque build :

1. Vérifier si un serveur Vite lié à ce projet est actif.
2. Fermer complètement ce serveur Vite.
3. Lancer le build et attendre sa fin complète.
4. Vérifier que le build s’est terminé correctement.
5. Relancer Vite seulement après la fin du build et de ses vérifications.

Ne jamais lancer un build pendant qu’un serveur Vite associé est encore actif.

## 3. Déploiement

Pour chaque déploiement :

1. Attendre la fin complète de la commande de déploiement.
2. Vérifier explicitement que le déploiement a réussi.
3. Fermer l’invite de commande ou le processus terminal ayant servi au déploiement.
4. Vérifier que ce processus est réellement terminé avant de poursuivre ou de manipuler les dossiers concernés.

Ne jamais laisser une invite de commande de déploiement ouverte après la fin de l’opération.

## 4. Refus ou blocage Windows

Lorsqu’une opération est refusée par Windows ou qu’un dossier semble bloqué :

1. Vérifier d’abord qu’aucun serveur Vite lié au projet ne tourne encore.
2. Vérifier ensuite qu’aucune invite de commande ou aucun processus lancé pour un build ou un déploiement n’a été oublié.
3. Fermer les processus concernés, puis réessayer une seule fois.
4. Si le refus persiste, arrêter immédiatement l’opération en cours et demander à l’utilisateur de résoudre le blocage. Un redémarrage du poste suffit généralement.

En cas de refus persistant, ne pas modifier les permissions Windows, ne pas reprendre la propriété des dossiers, ne pas créer de dossier de remplacement et ne pas contourner le problème par une autre cible de build ou de déploiement sans autorisation explicite de l’utilisateur.