# Worker `fractal-ordinal-live`

Ce Worker sert les deux applications GitHub Pages, Ordinal Punks et Fractal Pokédex. Le module d’authentification est `auth-bip322.js`; le point d’entrée est `fractal-ordinal-live.js`.

## Build et contrôles

Depuis la racine du dépôt :

```sh
pnpm check
pnpm build
pnpm exec vitest run
node --test workers/fractal-ordinal-live.test.mjs
pnpm dlx wrangler@4.150.0 deploy --dry-run --outdir=/tmp/fractal-worker-dry-run
```

Le bundler Wrangler regroupe le point d’entrée et ses imports. Le dry-run compile et valide la configuration sans téléverser ni activer une version.

## Configuration Wrangler et Durable Object

`wrangler.jsonc` cible le nom de Worker Cloudflare existant `fractal-ordinal-live`, garde l’accès `workers.dev` déjà utilisé, et déclare `AUTH_STORAGE` vers la classe exportée `AuthStorage` en stockage SQLite. La déclaration `exports` est le flux déclaratif Cloudflare actuel; ne pas la mélanger avec l’ancien tableau `migrations`.

L’API de réglages du Worker actif ne renvoie aucune date de compatibilité explicite. Cloudflare documente que l’absence de date à l’upload API prend la valeur effective `2021-11-02`; la configuration Wrangler la fige pour éviter un changement runtime implicite au premier déploiement. Réévaluer cette date séparément, avec des tests dédiés, avant de la faire avancer.

La production utilise le binding Cloudflare secret `UNISAT_API_KEY`. Ne jamais mettre sa valeur dans le code, `wrangler.jsonc`, `.dev.vars` commité, les logs ou les réponses API. Les déploiements Wrangler ne suppriment pas les secrets Cloudflare existants; une suppression exige la commande explicite `wrangler secret delete`. Pour le développement local, un fichier `.dev.vars` non commité peut être utilisé; il est ignoré par Git.

## CI/CD Cloudflare

Le workflow `.github/workflows/deploy-cloudflare-worker.yml` déploie uniquement le Worker et seulement pour les changements de `workers/**`, de `wrangler.jsonc`, des dépendances ou du workflow. Il exécute d’abord le dry-run puis `wrangler deploy --strict`, avec le Worker d’environnement GitHub `cloudflare-production` et un verrou de concurrence.

Les secrets GitHub requis sont :

- `CLOUDFLARE_API_TOKEN` : token limité au compte Cloudflare concerné et à la permission **Edit Cloudflare Workers**;
- `CLOUDFLARE_ACCOUNT_ID` : identifiant du compte Cloudflare cible.

Ne jamais les stocker dans le dépôt ou les transmettre dans un message. Le workflow manuel accepte aussi une exécution depuis `main` lorsque le champ de confirmation vaut exactement `deploy-production`. La publication automatique est restreinte aux fichiers Worker afin qu’une modification frontend seule ne redéploie pas le Worker.

Le workflow de contrôles sur pull request exécute le même dry-run Wrangler sans identifiants Cloudflare et sans effet distant.

## Procédure post-déploiement

Après activation, vérifier sur les deux origines autorisées : `OPTIONS`, `POST /api/auth/challenge`, `POST /api/auth/verify`, `GET /api/auth/session` et `POST /api/auth/logout`, pour les sites `punks` et `pokedex`. Utiliser un wallet de test contrôlé ou un vecteur public de test, puis révoquer toute session de test. Vérifier également le type du binding `UNISAT_API_KEY`, les routes Inscribe existantes et `MAX_INSCRIBE_FILES = 1_000`.

Les cookies d’authentification ne sont pas stockés dans `localStorage`. Les routes d’auth sont en `no-store`; le Worker ne conserve pas la signature BIP-322 ni le jeton de session en clair.
