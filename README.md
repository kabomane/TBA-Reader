# TBA Reader

Application éditoriale React permettant de publier et consulter les épisodes **Thomas Bizarre Aventure** sous forme de texte Markdown, audio, vidéo YouTube et image.

Le site public est statique. Supabase fournit la base PostgreSQL, les opérations d’administration et le stockage principal. Cloudflare R2 peut recevoir des épisodes complets lorsque Supabase approche de son quota ou qu’un média dépasse sa limite par fichier. Firebase Hosting publie le frontend.

Ce document décrit l’architecture actuellement déployée. Il ne doit contenir aucun PIN, hash privé, jeton Cloudflare, secret Supabase ou autre identifiant sensible.

---

## Fonctionnalités

### Site public

- L’accueil affiche le dernier épisode publié.
- La liste contient les épisodes précédents avec recherche, filtre de format et filtre par hashtag.
- Chaque épisode possède une route stable `/tba/<share_id>`.
- Le lecteur prend en charge Markdown, images, MP3, M4A et vidéos YouTube.
- Les signets restent dans `localStorage` et ne sont pas synchronisés entre appareils.
- Une clé visuelle `TBA-XXXX-00` peut être chargée depuis **À propos** pour afficher les épisodes associés.
- La vitrine utilise un cache local léger avec actualisation en arrière-plan des métadonnées publiques.

### Espace créateur

L’administration est protégée par un PIN partagé de six chiffres et comporte une navigation compacte à trois boutons :

1. le bouton de mode bascule entre **Contenu** et **Infrastructure** ;
2. l’action principale ouvre **Créer** ou **Stockage** ;
3. l’action secondaire ouvre **Gérer** ou **Paramètres**.

Le mode Contenu permet de :

- créer et modifier un épisode ;
- envoyer une image ou un audio ;
- rédiger le corps Markdown ;
- ajouter une vidéo YouTube ;
- définir une clé d’accès visuelle ;
- rechercher, renuméroter et supprimer les épisodes.

Le mode Infrastructure permet de :

- consulter l’espace utilisé chez Supabase et R2 ;
- voir la taille et le fournisseur de chaque épisode ;
- migrer manuellement un épisode complet entre Supabase et R2 ;
- configurer ou désactiver la migration automatique ;
- connecter Cloudflare R2 ;
- changer le PIN administrateur.

Entrer dans l’écran Stockage ne déclenche pas une nouvelle lecture. Le bouton **Actualiser** lance explicitement le relevé.

---

## Stack technique

- **React 19** : interface.
- **Vite 6** : développement et build statique.
- **Supabase PostgreSQL** : métadonnées, paramètres et suivi des migrations.
- **Supabase Storage** : stockage principal des fichiers.
- **Supabase Edge Functions** : validation du PIN et opérations privilégiées.
- **Cloudflare R2** : stockage secondaire compatible S3.
- **aws4fetch** : signature des envois directs vers R2 avec des identifiants temporaires.
- **Firebase Hosting** : hébergement du build et réécriture SPA.
- **localStorage** : cache vitrine, signets, corps Markdown récents et clé TBA chargée.
- **react-markdown** et **remark-gfm** : rendu Markdown.

Supabase Realtime n’est pas utilisé. Le frontend n’ouvre aucun canal ou WebSocket et `public.episodes` a été retirée de la publication `supabase_realtime`.

---

## Organisation du dépôt

```text
.
├── AGENTS.md
├── README.md
├── index.html
├── package.json
├── package-lock.json
├── vite.config.js
├── public/
├── scripts/
├── src/
│   ├── App.jsx
│   ├── accessKey.js
│   ├── main.jsx
│   ├── markdown.js
│   ├── styles.css
│   └── supabase.js
├── supabase/
│   ├── functions/
│   │   └── tba-admin/
│   └── migrations/
├── build/
└── deploy/
    ├── firebase.json
    ├── .firebaserc
    └── public-current/
```

- `src/` est la source du frontend.
- `supabase/migrations/` est la source de vérité du schéma.
- `supabase/functions/tba-admin/` contient l’Edge Function d’administration.
- `build/` est généré par Vite.
- `deploy/public-current/` doit être une copie exacte de `build/` avant publication Firebase.

---

## Modèle PostgreSQL

### `public.episodes`

Les colonnes éditoriales restent séparées afin de conserver des requêtes simples.

| Colonne | Rôle |
| --- | --- |
| `id` | Identifiant technique stable de l’épisode. |
| `share_id` | Identifiant public court et immuable. |
| `number` | Numéro éditorial unique et renumérotabile. |
| `title` | Titre. |
| `description` | Résumé public. |
| `type` | `Texte`, `Vidéo` ou `Vocal` ; l’interface affiche Audio pour `Vocal`. |
| `tags` | Hashtags normalisés. |
| `published_on` | Date éditoriale. |
| `duration` | Durée libre. |
| `palette` | Variante du visuel généré. |
| `token` | SHA-256 tronqué de la clé TBA, ou `NULL` pour un épisode public. |
| `created_at` | Date technique stable. |
| `storage_provider` | Fournisseur de l’épisode : `supabase` ou `r2`. |
| `storage_bytes` | Taille totale du Markdown, de l’image et de l’audio. |
| `data` | Manifeste JSON des fichiers et de la vidéo. |

Le manifeste `data` suit cette forme :

```json
{
  "youtube": "identifiant-video-ou-null",
  "body": {
    "key": "episodes/<id>/body.md",
    "size": 1234,
    "mime": "text/markdown;charset=utf-8",
    "etag": "optionnel"
  },
  "image": {
    "key": "episodes/<id>/image-<timestamp>-<fichier>",
    "size": 1234,
    "mime": "image/jpeg",
    "etag": "optionnel"
  },
  "audio": null
}
```

`body`, `image` et `audio` utilisent uniquement une clé relative. Les URLs publiques complètes ne sont pas enregistrées dans PostgreSQL.

### Tables de stockage

- `tba_settings` : migration automatique, seuils, quota de référence, configuration privée R2 et état activé/désactivé.
- `tba_storage_jobs` : état des copies Supabase ↔ R2 et reprise des erreurs.
- `tba_public_storage` : uniquement l’état public minimal de R2 et son URL publique.

Les tables privées ont RLS activé et aucune politique publique. `tba_public_storage` expose seulement les valeurs nécessaires à la lecture des médias R2.

---

## Stockage hybride Supabase et Cloudflare R2

### Principe principal

Un épisode est toujours entièrement stocké chez un seul fournisseur. Son Markdown, son image et son audio ne sont jamais volontairement répartis entre Supabase et R2.

Les chemins restent identiques chez les deux fournisseurs :

```text
episodes/<id>/body.md
episodes/<id>/image-<timestamp>-<nom-sécurisé>
episodes/<id>/audio-<timestamp>-<nom-sécurisé>
```

Cette stabilité permet de migrer sans réécrire les clés de chaque fichier. Seuls `storage_provider`, `storage_bytes` et le manifeste sont utilisés pour résoudre les URLs.

### Choix du fournisseur lors d’une création

- Supabase est utilisé par défaut.
- Si l’épisode est déjà chez R2, une modification reste chez R2.
- Si une nouvelle image ou un nouvel audio dépasse `50 000 000` octets, l’épisode complet part directement vers R2.
- R2 doit être configuré avant l’envoi d’un fichier dépassant cette limite.

### Migration manuelle

La migration manuelle est disponible uniquement dans **Infrastructure → Stockage**.

1. L’Edge Function crée ou reprend un job.
2. Le navigateur télécharge les fichiers depuis le fournisseur source.
3. Le navigateur les envoie vers la destination avec des autorisations temporaires ou des URLs signées.
4. L’Edge Function vérifie chaque objet.
5. La base bascule le fournisseur seulement après vérification.
6. Les anciens objets sont supprimés après validation du nouveau stockage.

Un retour vers Supabase est refusé si :

- un fichier dépasse 50 Mo ;
- le retour dépasserait 75 % du quota quand l’automatisation est active ;
- le retour dépasserait 95 % du quota quand l’automatisation est désactivée.

### Migration automatique

- Désactivée par défaut.
- Quota de référence : `1 000 000 000` octets.
- Déclenchement par défaut : 75 %.
- Objectif après migration : 60 %.
- Les épisodes Supabase les plus lourds sont déplacés en premier.
- Le travail est orchestré côté navigateur pendant une session administrateur afin d’éviter les limites longues d’une Edge Function.
- Aucun processus planifié ne tourne lorsque personne n’utilise l’administration.

### Configuration R2

Le formulaire Paramètres demande :

- l’Account ID Cloudflare ;
- un jeton API limité à R2 ;
- l’Access Key ID parent ;
- le nom du bucket.

La connexion R2 et son activation sont séparées. Le switch R2 est désactivé par défaut. Le couper bloque les nouveaux envois et les migrations vers R2 sans supprimer la configuration, le bucket ou les médias déjà publiés. Les retours de R2 vers Supabase restent possibles.

L’Edge Function :

- vérifie le jeton ;
- crée le bucket s’il manque ;
- configure CORS pour les domaines autorisés ;
- active l’adresse publique `r2.dev` ;
- conserve les valeurs sensibles dans Supabase Vault ;
- génère des identifiants R2 temporaires limités aux objets de l’épisode.

Ne jamais placer un secret Cloudflare dans React, Firebase Hosting ou ce README.

---

## Edge Function `tba-admin`

La fonction accepte uniquement `POST`. La passerelle Supabase ne vérifie pas de session Auth pour ce point d’entrée ; l’autorisation applicative repose sur le PIN vérifié dans la fonction.

| Action | Usage |
| --- | --- |
| `verify` | Vérifier le PIN. |
| `storage-status` | Lire quotas, fournisseurs, jobs et fichiers orphelins. |
| `settings-save` | Enregistrer activation et seuils de migration. |
| `change-pin` | Remplacer le hash du PIN dans Vault. |
| `r2-setup` | Créer et connecter le bucket R2. |
| `r2-credentials` | Produire des identifiants temporaires limités. |
| `sign-upload` | Créer une URL d’upload Supabase signée. |
| `migration-supabase-sign` | Signer les objets lors d’un retour vers Supabase. |
| `save` | Valider et enregistrer un épisode. |
| `migration-start` | Préparer ou reprendre une migration. |
| `migration-finish` | Vérifier, basculer le fournisseur et nettoyer la source. |
| `migration-error` | Conserver l’erreur du job. |
| `delete` | Supprimer l’épisode et ses fichiers chez son fournisseur. |
| `renumber` | Appeler la RPC de renumérotation. |

Le PIN est limité à six chiffres. Son hash et les secrets R2 sont stockés dans Vault. Une limitation temporaire en mémoire ralentit les tentatives de PIN incorrectes. Ce modèle convient au cercle privé prévu pour le projet, mais ne remplace pas Supabase Auth pour un produit public multi-utilisateur.

CORS accepte les origines locales privées nécessaires au développement et les domaines Firebase TBA. CORS n’est pas un mécanisme d’authentification.

---

## Lecture publique, RLS et Realtime

- `public.episodes` est lisible par le frontend public selon ses politiques RLS.
- Aucune écriture PostgreSQL publique n’est autorisée.
- Les opérations privilégiées utilisent la clé serveur uniquement dans l’Edge Function.
- Les clés publishable visibles dans le navigateur ne sont pas des secrets.
- Aucun composant n’utilise Supabase Realtime.
- `public.episodes` ne fait plus partie de `supabase_realtime`.

---

## Clés d’accès TBA

Le format visuel est `AAA-AAAA-00`. Le navigateur calcule un SHA-256, conserve les 16 premiers caractères hexadécimaux puis filtre les épisodes correspondants.

Ce filtrage est une fonction de présentation adaptée au projet familial : il ne protège pas réellement des lignes ou fichiers publics.

`crypto.subtle` demande un contexte sécurisé. Le hachage fonctionne sur Firebase en HTTPS et sur `http://localhost`. Il peut être indisponible lorsque Vite est ouvert depuis une IP locale en HTTP, par exemple `http://192.168.x.x:5174`.

---

## Markdown et médias

Le corps de l’épisode reste un fichier `body.md`. Le rendu prend en charge :

- titres et paragraphes ;
- gras, italique et liens HTTP/HTTPS ;
- tableaux GFM avec défilement horizontal sur téléphone ;
- `==texte accentué==` ;
- séparateurs `---` et `---Libellé`.

Le HTML brut n’est pas activé. Les lecteurs audio prennent en charge MP3 et M4A avec progression et vitesses de lecture.

---

## Cache local

La vitrine suit une logique stale-while-revalidate :

1. lire immédiatement la liste légère depuis `localStorage` ;
2. afficher cette copie ;
3. demander les métadonnées fraîches à Supabase ;
4. remplacer le cache en cas de succès ;
5. conserver l’affichage avec un avertissement si Supabase reste indisponible.

Le cache vitrine ne contient pas les droits créateur. Les signets, la clé TBA et le cache des corps Markdown utilisent des entrées distinctes.

---

## Routage

| Vue | Route |
| --- | --- |
| Accueil | `/` |
| Listes | `/listes` |
| Sujet | `/listes?sujet=<hashtag>` |
| Signets | `/signets` |
| À propos | `/informations` |
| Épisode | `/tba/<share_id>` |

Firebase réécrit toutes les routes vers `index.html`.

---

## Installation locale

```powershell
npm ci
npm run dev -- --host 0.0.0.0 --port 5174
```

- Utiliser `http://localhost:5174` sur le poste qui exécute Vite pour tester le hachage des clés TBA.
- L’adresse réseau permet les tests depuis téléphone et tablette, sauf les API exigeant HTTPS comme `crypto.subtle`.
- Respecter systématiquement les procédures Vite de [`AGENTS.md`](./AGENTS.md).

---

## Build et déploiement Firebase

Avant chaque build :

1. identifier le serveur Vite Bizave ;
2. l’arrêter complètement ;
3. lancer `npm run build` ;
4. vérifier `build/index.html` et les bundles hachés ;
5. relancer Vite sur le même port après les tests.

Pour publier :

1. vérifier les chemins absolus de `build/` et `deploy/public-current/` ;
2. arrêter Vite ;
3. remplacer uniquement le contenu de `deploy/public-current/` par la copie exacte du build ;
4. lancer depuis `deploy/` :

```powershell
npm exec firebase -- deploy --only hosting
```

5. attendre `Deploy complete!` ;
6. vérifier `https://tbizave-reader.web.app` et le nouveau bundle ;
7. vérifier qu’aucun processus de déploiement ne reste actif ;
8. relancer Vite sur `0.0.0.0:5174`.

Ne pas créer un dossier de déploiement alternatif pour contourner un blocage Windows. Suivre [`AGENTS.md`](./AGENTS.md).

---

## Tests d’acceptation

### Lecture

- Accueil, listes, recherche, formats et hashtags fonctionnent.
- Une route d’épisode survit au rechargement direct.
- Markdown, images, audio et YouTube fonctionnent sur téléphone et ordinateur.
- Une clé TBA se charge sur HTTPS et affiche les épisodes associés.

### Administration

- Un mauvais PIN est refusé.
- Création, modification, suppression et renumérotation conservent les identifiants stables.
- Un fichier supérieur à 50 Mo sélectionne R2.
- Une migration vérifie la destination avant de supprimer la source.
- L’épisode reste entièrement chez un fournisseur.
- L’entrée dans Stockage ne lance pas de relevé automatique.
- La taille et le fournisseur ne sont affichés que dans Stockage.

### Infrastructure

- La migration automatique est désactivée sur une nouvelle configuration.
- Les seuils 75 % et 60 % sont appliqués.
- R2 est inaccessible tant que sa configuration n’est pas validée.
- Aucun canal ou WebSocket Realtime n’est ouvert.
- Les conseillers Supabase ne signalent aucune faille active liée aux nouvelles tables.

### Responsive

- Tester téléphone, tablette verticale, tablette horizontale et ordinateur.
- Vérifier l’absence de débordement horizontal.
- Vérifier la barre administrateur à trois boutons.
- Vérifier les focus clavier, libellés accessibles et `prefers-reduced-motion`.

---

## Limites connues

- Le PIN partagé n’est pas une authentification forte.
- Les clés TBA filtrent l’affichage mais ne constituent pas une autorisation serveur.
- Les buckets publics rendent les fichiers accessibles à toute personne possédant leur URL.
- La migration navigateur exige que l’administration reste ouverte pendant la copie.
- Aucun Cron ne lance une migration lorsque personne n’utilise l’application.
- Les signets et caches ne sont pas synchronisés entre appareils.
- Les métadonnées Open Graph restent statiques pour tout le site.
- Le retour vers Supabase est impossible si un objet dépasse 50 Mo.

---

## Règles à préserver

1. Lire et respecter `AGENTS.md` avant toute intervention.
2. Préserver `id`, `share_id` et `created_at` lors des modifications.
3. Garder toutes les métadonnées éditoriales dans leurs colonnes dédiées.
4. Maintenir un épisode complet chez un seul fournisseur.
5. Ne jamais basculer `storage_provider` avant vérification de tous les objets.
6. Ne jamais exposer une clé serveur, un jeton Cloudflare ou un PIN dans React ou Git.
7. Ne jamais accorder d’écriture publique aux tables ou aux buckets.
8. Ne pas réactiver Realtime sans besoin explicite.
9. Ne pas installer d’outil globalement si une exécution locale suffit.
10. Ne pas contourner les blocages Windows par des permissions forcées ou une autre cible de build.

---

## Documentation utile

- [Supabase Storage](https://supabase.com/docs/guides/storage)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Supabase Vault](https://supabase.com/docs/guides/database/vault)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [Firebase Hosting](https://firebase.google.com/docs/hosting)
