# UniSat et Cloudflare — configuration des réseaux

## Source de vérité

Les deux sites utilisent **un seul Worker Cloudflare partagé** : `fractal-ordinal-live` (`https://fractal-ordinal-live.servostar23.workers.dev`). La configuration de déploiement et le code Worker restent dans le dépôt Ordinal Punks. Le dépôt Pokédex ne doit pas déployer un second Worker ni créer un autre Durable Object, afin de conserver un seul point d’accès API et une seule source de vérité pour les sessions.

## Routage réseau

| Réseau UniSat | Valeur réseau | API UniSat | Secret principal |
| --- | --- | --- | --- |
| Fractal Bitcoin mainnet | `FRACTAL_BITCOIN_MAINNET` | `https://open-api-fractal.unisat.io` | `FRACTAL_BITCOIN_API` (alias historique `UNISAT_API_KEY`) |
| Bitcoin mainnet | `BITCOIN_MAINNET` | `https://open-api.unisat.io` | `BITCOIN_API` (alias historique `UNISAT_BITCOIN_API`) |

Le Worker choisit l’API et la clé à partir du réseau demandé. Ne pas réutiliser la clé Bitcoin pour Fractal ou inversement. Un fallback n’est essayé que si un secret de secours distinct pour le même réseau est configuré et que l’erreur amont correspond aux cas de quota traités par le code. Un HTTP 403 générique ne doit pas être interprété automatiquement comme un quota.

## Secrets et variables Cloudflare

Secrets principaux requis par la configuration Wrangler :
- `FRACTAL_BITCOIN_API` — clé UniSat Fractal Bitcoin (prioritaire; `UNISAT_API_KEY` reste accepté comme alias).
- `BITCOIN_API` — clé UniSat Bitcoin mainnet (prioritaire; `UNISAT_BITCOIN_API` reste accepté comme alias).
- `ETHEREUM_API` — alias accepté pour un endpoint RPC EVM uniquement si sa valeur est une URL JSON-RPC complète en HTTPS; une clé API brute seule ne suffit pas. `ETH_API` reste accepté comme alias historique.

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

## Paramètres de scan « My inscriptions »

Le composant `client/src/components/UniSatWalletConnect.tsx` utilise les mêmes paramètres de scan que la branche Manus `manus/ordinal-punks-update-oct2026` :
- taille d’une page UniSat : `INSCRIPTIONS_PAGE_SIZE = 50` inscriptions;
- pagination à partir du curseur `0` pour un nouveau scan, ou du curseur mémorisé pour charger la suite;
- lecture des pages jusqu’à ce que le curseur atteigne le total annoncé par UniSat ou qu’une page vide soit renvoyée;
- validation du format de chaque inscription (`txid` hexadécimal de 64 caractères suivi de `i` et d’un index), puis dédoublonnage par identifiant;
- vérification du réseau principal actif et du compte connecté avant de conserver les résultats;
- annulation d’un scan précédent quand un nouveau scan démarre ou que le portefeuille est réinitialisé.

La valeur de 50 est déjà identique dans les branches Manus et de correction actuelles; elle n’a donc pas été modifiée arbitrairement. Le scan reste paginé et peut charger plusieurs pages. La taille d’une page UniSat n’est pas une garantie que toutes les inscriptions ont été indexées par le fournisseur.
