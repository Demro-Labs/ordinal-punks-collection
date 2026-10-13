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

Le workflow `.github/workflows/deploy-cloudflare-worker.yml` déploie uniquement le Worker et seulement pour les changements de `workers/**`, de `wrangler.jsonc`, des dépendances ou du workflow. Il exécute le dry-run Wrangler épinglé, le smoke test workerd et les contrôles de production pour les deux applications. Le premier déploiement de réconciliation omet `--strict`, car le Worker actif avait été publié avec l’ancienne Script API; après cette migration, réactiver le mode strict pour les déploiements ordinaires. Le workflow utilise l’environnement GitHub `cloudflare-production` et un verrou de concurrence.

Les secrets GitHub requis sont :

- `CLOUDFLARE_API_TOKEN` : token limité au compte Cloudflare concerné et à la permission **Edit Cloudflare Workers**;
- `CLOUDFLARE_ACCOUNT_ID` : identifiant du compte Cloudflare cible.

Ne jamais les stocker dans le dépôt ou les transmettre dans un message. Le workflow manuel accepte aussi une exécution depuis `main` lorsque le champ de confirmation vaut exactement `deploy-production`. La publication automatique est restreinte aux fichiers Worker afin qu’une modification frontend seule ne redéploie pas le Worker.

Le workflow de contrôles sur pull request exécute le même dry-run Wrangler sans identifiants Cloudflare et sans effet distant.

## Procédure post-déploiement

Après activation, vérifier sur les deux origines autorisées : `OPTIONS`, `POST /api/auth/challenge`, `POST /api/auth/verify`, `GET /api/auth/session` et `POST /api/auth/logout`, pour les sites `punks` et `pokedex`. Utiliser un wallet de test contrôlé ou un vecteur public de test, puis révoquer toute session de test. Vérifier également le type du binding `UNISAT_API_KEY`, les routes Inscribe existantes et `MAX_INSCRIBE_FILES = 1_000`.

Les cookies d’authentification ne sont pas stockés dans `localStorage`. Les routes d’auth sont en `no-store`; le Worker ne conserve pas la signature BIP-322 ni le jeton de session en clair.

## Stratégie de production

Le Worker unique `fractal-ordinal-live` sert Punks et Pokédex. Ne pas créer un second Worker Wrangler, un `env.production` avec un autre nom, ni un autre Durable Object pour Pokédex : cela créerait deux sources de vérité et pourrait séparer les sessions. Le déploiement reste une publication ciblée du Worker partagé depuis ce dépôt; les deux pages GitHub restent déployées par leurs propres workflows.

`wrangler.jsonc` active Smart Placement, adapté aux requêtes vers plusieurs API amont. Cloudflare l’analyse à partir du trafic et peut prendre jusqu’à 15 minutes pour décider d’un placement; vérifier ensuite le statut et l’en-tête `cf-placement` dans les réponses. Le Worker utilise déjà Cache API uniquement pour les données publiques du marché et des soldes, avec des durées courtes. Les routes d’authentification, de confirmation UTXO et d’inscription restent `no-store`. Les frais ont déjà deux sources indépendantes, UniSat et Mempool; ne pas ajouter l’URL de secours fictive de l’exemple Gemini sans endpoint Fractal réellement contrôlé.

La limitation existante est spécifique aux routes : les routes d’authentification utilisent un compteur durable dans `AuthStorage`, les inscriptions ont une limite dédiée, et les lectures ont un garde-fou par isolate. Le Worker est publié sur `workers.dev`, pas derrière une zone personnalisée; ne pas appliquer une règle WAF de zone au chemin `/api/fractal/broadcast`, qui n’existe pas dans cette API. Les opérations d’inscription passent par `/api/inscribe/order`; aucun endpoint générique `/api/fractal/broadcast` n’est exposé. Conserver la liste CORS explicite des origines; ne jamais remplacer par `*`, ni accepter une validation de signature qui renvoie toujours `true`.

Le Durable Object SQLite `AuthStorage` est une migration de cycle de vie. Cloudflare précise qu’un changement de cycle de vie des Durable Objects est atomique et ne peut pas être envoyé comme un gradual deployment; un rollback vers une version antérieure à cette migration n’est pas possible. Le premier déploiement est donc une coupure contrôlée après dry-run et test workerd, suivie immédiatement des vérifications automatisées des deux marchés, des sessions anonymes et des preflights CORS. Ne pas répartir cette migration à 10 %. Si le smoke test post-déploiement échoue, corriger vers l’avant en conservant la classe `AuthStorage`; les rollouts progressifs et le rollback Wrangler vers une version post-migration sont à utiliser pour les changements suivants qui ne modifient pas le cycle de vie du Durable Object.

L’observabilité est échantillonnée à 10 % et les journaux d’invocation sont désactivés afin de ne pas persister les URL de requête contenant des adresses de wallet. Les avertissements applicatifs restent échantillonnés et n’incluent ni clé API ni signature. Source : [configuration et Smart Placement Cloudflare](https://developers.cloudflare.com/workers/configuration/placement/), [déploiements progressifs avec Durable Objects](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/), [retours arrière](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) et [journaux Workers](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).
