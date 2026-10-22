# UniSat et Cloudflare — configuration des réseaux

## Source de vérité

Les deux sites utilisent **un seul Worker Cloudflare partagé** : `fractal-ordinal-live` (`https://fractal-ordinal-live.servostar23.workers.dev`). La configuration de déploiement et le code Worker restent dans le dépôt Ordinal Punks. Le dépôt Pokédex ne doit pas déployer un second Worker ni créer un autre Durable Object, afin de conserver un seul point d’accès API et une seule source de vérité pour les sessions.

## Routage réseau

| Réseau UniSat | Valeur réseau | API UniSat | Secret principal |
| --- | --- | --- | --- |
| Fractal Bitcoin mainnet | `FRACTAL_BITCOIN_MAINNET` | `https://open-api-fractal.unisat.io` | `UNISAT_API_KEY` |
| Bitcoin mainnet | `BITCOIN_MAINNET` | `https://open-api.unisat.io` | `UNISAT_BITCOIN_API` |

Le Worker choisit l’API et la clé à partir du réseau demandé. Ne pas réutiliser la clé Bitcoin pour Fractal ou inversement. Un fallback n’est essayé que si un secret de secours distinct pour le même réseau est configuré et que l’erreur amont correspond aux cas de quota traités par le code. Un HTTP 403 générique ne doit pas être interprété automatiquement comme un quota.

## Secrets et variables Cloudflare

Secrets principaux requis par la configuration Wrangler :
- `UNISAT_API_KEY` — clé UniSat Fractal Bitcoin.
- `UNISAT_BITCOIN_API` — clé UniSat Bitcoin mainnet.
- `ETH_API` — binding historique utilisé comme secours RPC compatible là où le code le prévoit.

Secrets facultatifs, uniquement si des clés de secours distinctes ont été émises :
- `UNISAT_API_KEY_FALLBACK` — secours Fractal Bitcoin.
- `UNISAT_BITCOIN_API_FALLBACK` — secours Bitcoin mainnet.

Bindings RPC facultatifs pour BRC20-Prog :
- `BRC20_PROG_RPC_URL` — RPC EVM Bitcoin mainnet.
- `BRC20_PROG_FRACTAL_RPC_URL` — RPC EVM Fractal Bitcoin.
- `BRC20_PROG_RPC_USER` et `BRC20_PROG_RPC_PASSWORD` — uniquement si le fournisseur RPC exige une authentification séparée.

Configurer les valeurs avec `wrangler secret put NOM_DU_SECRET` depuis le dépôt Worker, ou via les paramètres du Worker Cloudflare. Ne jamais commiter de valeurs de secrets, de fichiers `.dev.vars` réels, de clés API ou de tokens Cloudflare.

## Déploiement et contrôles

Le fichier `wrangler.jsonc` configure le Worker partagé, Smart Placement, l’observabilité échantillonnée et le Durable Object SQLite `AUTH_STORAGE`. Le workflow `.github/workflows/deploy-cloudflare-worker.yml` est conservé dans ce dépôt; il ne déploie qu’à partir de `main` et utilise les secrets GitHub `CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ACCOUNT_ID`. Les secrets d’API UniSat restent dans les secrets/bindings Cloudflare, pas dans les variables du workflow.

Avant toute publication, exécuter les contrôles locaux documentés dans `workers/README.md`, le dry-run Wrangler et les tests Worker. Une configuration présente dans Git ne prouve pas qu’un secret distant est renseigné ni qu’un déploiement a réussi. Après publication, vérifier séparément les routes BTC et Fractal et les deux origines web autorisées.

## Protection des UTXO

La configuration réseau ne modifie pas les règles de sécurité Local Vault. Les sorties contenant une inscription, un Rune ou un Alkane, ainsi que les sorties dont l’état ne peut pas être vérifié, restent exclues des UTXO de frais. Ne pas désactiver ces contrôles pour contourner un solde de frais insuffisant.
