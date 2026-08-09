# Cloner et reconfigurer TBA Reader

Ce guide permet d’installer une copie indépendante de TBA Reader avec son propre projet Supabase, son propre bucket Cloudflare R2, son propre domaine et son propre PIN.

Ne réutilisez jamais les identifiants, jetons, secrets ou PIN de l’installation d’origine. Une clé Supabase `publishable` peut être placée dans le frontend ; une clé `secret` ou `service_role` ne doit jamais quitter l’Edge Function.

## 1. Prérequis

- Node.js et npm ;
- Git ;
- un projet Supabase ;
- Supabase CLI, lancé avec `npx supabase` ;
- un compte Cloudflare avec R2 activé ;
- un projet Firebase Hosting, ou un autre hébergeur statique compatible SPA.

```powershell
git clone https://github.com/kabomane/TBA-Reader.git
cd TBA-Reader
npm ci
```

## 2. Valeurs en dur à remplacer

### Frontend Supabase

Dans `src/supabase.js`, remplacez :

| Constante | Valeur attendue |
| --- | --- |
| `SUPABASE_URL` | URL API du nouveau projet, par exemple `https://<project-ref>.supabase.co`. |
| `SUPABASE_PUBLISHABLE_KEY` | Clé `sb_publishable_...` active du nouveau projet. |
| `MEDIA_BUCKET` | Conserver `tba-media`, sauf si le même changement est réalisé dans les migrations et l’Edge Function. |

`MAX_SUPABASE_FILE_BYTES` vaut `50_000_000`. Ne la changez que si la limite réelle du bucket Supabase est changée en même temps.

### Nom du bucket R2

Dans `src/App.jsx`, la valeur initiale `tba-reader-media` est seulement une suggestion affichée dans Paramètres. Remplacez-la si vous souhaitez proposer un autre nom par défaut.

### Firebase et domaine public

Remplacez :

- le projet Firebase dans `deploy/.firebaserc` ;
- le site Hosting dans `deploy/firebase.json` ;
- les URLs `og:image`, `og:url` et `twitter:image` dans `index.html` ;
- les trois domaines autorisés dans `supabase/functions/tba-admin/index.ts` : fonction `allowedOrigin` et liste `corsOrigins` de l’action `r2-setup`.

Conservez les origines sans chemin final : `https://exemple.fr`, pas `https://exemple.fr/chemin`.

## 3. Préparer une base Supabase neuve

Les migrations du dépôt sont l’historique d’évolution de l’application. Elles commencent après la création de la table historique `episodes`. Sur un projet entièrement neuf, exécutez donc une seule fois ce bootstrap dans le SQL Editor Supabase avant `db push` :

```sql
create table public.episodes (
  id text primary key,
  share_id text not null unique check (share_id ~ '^[a-z0-9]{8}$'),
  number integer not null unique check (number > 0),
  title text not null,
  type text not null check (type in ('Texte', 'Vidéo', 'Vocal')),
  tags text[] not null default '{}',
  published_on date not null,
  duration text not null default '',
  description text not null,
  palette smallint not null default 0 check (palette between 0 and 5),
  youtube_url text,
  image_path text,
  audio_path text,
  created_at timestamptz not null default now()
);

alter table public.episodes enable row level security;

create policy "Public can read TBA episodes"
on public.episodes for select
to anon, authenticated
using (true);

revoke all on public.episodes from public;
grant select on public.episodes to anon, authenticated;
grant select, insert, update, delete on public.episodes to service_role;

insert into storage.buckets (id, name, public, file_size_limit)
values ('tba-media', 'tba-media', true, 50000000)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;
```

Ensuite, liez le dépôt et appliquez toutes les migrations versionnées :

```powershell
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
npx supabase db push
npx supabase migration list --linked
```

Les migrations créent la configuration hybride, les tables de suivi, les RPC, Vault, la configuration publique R2, le nettoyage des jobs et retirent les anciennes colonnes médias. Elles laissent la migration automatique et R2 désactivés par défaut.

Après application, vérifiez que les tables suivantes ont RLS activé :

- `episodes` : lecture pour `anon` et `authenticated`, aucune écriture publique ;
- `tba_public_storage` : lecture publique uniquement ;
- `tba_settings` et `tba_storage_jobs` : accès `service_role` uniquement.

## 4. Initialiser le PIN administrateur

Choisissez un PIN de six chiffres. Ne l’écrivez ni dans Git ni dans React. Dans le SQL Editor, remplacez uniquement `123456` dans la requête suivante :

```sql
select vault.create_secret(
  encode(extensions.digest(convert_to('123456', 'UTF8'), 'sha256'), 'hex'),
  'tba_admin_pin_hash',
  'SHA-256 du PIN administrateur TBA Reader'
);
```

Une fois l’administration accessible, le PIN peut être changé depuis **Infrastructure → Paramètres**. Le nouveau hash remplace alors le secret Vault existant.

## 5. Déployer l’Edge Function

`tba-admin` possède sa propre authentification par PIN. Elle doit donc être déployée sans vérification JWT de la passerelle :

```powershell
npx supabase functions deploy tba-admin --project-ref <PROJECT_REF> --no-verify-jwt
```

Supabase fournit automatiquement `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` à la fonction hébergée. N’ajoutez jamais cette dernière au frontend.

Test minimal après déploiement : ouvrir l’administration et vérifier qu’un mauvais PIN est refusé, puis que le bon PIN ouvre l’espace créateur.

## 6. Configurer Cloudflare R2

Dans Cloudflare **R2 → Manage API Tokens**, créez un token parent **Admin Read & Write**. L’assistant doit pouvoir créer le bucket, modifier CORS et l’accès public, gérer les objets et générer des identifiants temporaires.

Conservez temporairement les trois valeurs affichées par Cloudflare :

- la valeur du jeton API `cfat_...` ;
- l’`Access Key ID` ;
- le `Secret Access Key`, uniquement pour votre sauvegarde personnelle. TBA Reader ne le demande pas.

Dans **Infrastructure → Paramètres → Bucket R2**, renseignez :

- l’Account ID Cloudflare ;
- l’Access Key ID comme `Access Key ID parent` ;
- la valeur `cfat_...` comme jeton API ;
- le nom du bucket.

L’assistant crée ou retrouve le bucket, configure CORS, active l’URL publique `r2.dev` et conserve le jeton dans Supabase Vault. Activez ensuite le switch R2. La migration automatique reste indépendante et désactivée tant que son propre switch n’est pas activé.

Pour une utilisation en production durable, préférez un domaine personnalisé R2 à `r2.dev`, qui est principalement prévu pour le développement. Si vous changez d’URL publique, mettez à jour `r2_public_url` dans `tba_settings` et `tba_public_storage` avec la même valeur.

### CORS R2

Les domaines présents dans `corsOrigins` sont appliqués lorsque **Créer et connecter R2** ou **Tester et reconfigurer** est lancé. Ajoutez-y tous les domaines de production avant le déploiement de l’Edge Function.

Pour créer une archive depuis Vite, l’origine locale exacte doit aussi être autorisée dans la politique CORS R2, par exemple :

- `http://localhost:5173` ;
- `http://127.0.0.1:5173` ;
- l’adresse LAN utilisée par le téléphone, avec son port.

Une image publique peut s’afficher sans cette permission, mais `fetch()` ne peut pas lire ses octets pour le ZIP. Les origines CORS doivent correspondre exactement au schéma, au domaine et au port.

## 7. Installer Firebase Hosting et le domaine

Dans `deploy/` :

```powershell
npm ci
npm exec firebase -- login
```

Associez le projet dans `deploy/.firebaserc`, le site dans `deploy/firebase.json`, puis configurez le domaine personnalisé dans la console Firebase Hosting. Ajoutez ce domaine aux deux listes CORS de l’Edge Function avant de la redéployer et de reconfigurer R2.

## 8. Build et publication

Respectez `AGENTS.md` : aucun serveur Vite du projet ne doit tourner pendant le build ou le déploiement.

```powershell
npm run build
```

Copiez ensuite le contenu de `build/` vers `deploy/public-current/`, puis :

```powershell
cd deploy
npm exec firebase -- deploy --only hosting
```

Firebase doit afficher `Deploy complete!`. Vérifiez ensuite le domaine Firebase, le domaine personnalisé, l’accès administrateur, un média Supabase, un média R2 et la création d’une archive.

## 9. Checklist finale

- la nouvelle URL et la clé publishable sont dans `src/supabase.js` ;
- aucune clé `service_role`, clé secrète R2 ou valeur de PIN n’est suivie par Git ;
- toutes les migrations sont appliquées et RLS est actif ;
- `tba-admin` est déployée avec `--no-verify-jwt` ;
- le hash du PIN existe dans Vault sous `tba_admin_pin_hash` ;
- les domaines sont autorisés par l’Edge Function et par R2 ;
- Firebase réécrit toutes les routes vers `index.html` ;
- R2 et la migration automatique sont désactivés jusqu’à activation explicite ;
- l’archive ZIP fonctionne depuis une origine autorisée sans supprimer de données.

## Documentation officielle

- [Développement local et migrations Supabase](https://supabase.com/docs/guides/local-development)
- [Déploiement des Edge Functions](https://supabase.com/docs/guides/functions/deploy)
- [Secrets des Edge Functions](https://supabase.com/docs/guides/functions/secrets)
- [Supabase Vault](https://supabase.com/docs/guides/database/vault)
- [Jetons Cloudflare R2](https://developers.cloudflare.com/r2/api/tokens/)
- [Identifiants R2 temporaires](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)
- [CORS Cloudflare R2](https://developers.cloudflare.com/r2/buckets/cors/)
- [Domaine personnalisé Firebase Hosting](https://firebase.google.com/docs/hosting/custom-domain)
