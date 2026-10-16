# Runbook Production — Worker Fractal partagé

Ce runbook couvre le Worker Cloudflare `fractal-ordinal-live`, utilisé par les deux sites GitHub Pages Punks et Pokédex. Il répond au guide Gemini [partagé ici](https://share.gemini.google/dZ4EKnciqkFp), en remplaçant ses exemples génériques par les commandes et contraintes réellement vérifiées pour ce dépôt.

## 1. Première minute : classifier l’incident

1. Distinguer une panne de page GitHub Pages d’une panne de l’API Worker. Les pages sont indépendantes du Worker :
   - `https://demro-labs.github.io/ordinal-punks-collection/`
   - `https://demro-labs.github.io/fractal-pokedex-ordinal-ledger/`
2. Vérifier les routes lecture seule des deux collections et des deux sessions anonymes. Pour les nouvelles routes Runes, utiliser uniquement une adresse de test contrôlée et éviter de l’inclure dans les journaux :

   ```bash
   base=https://fractal-ordinal-live.servostar23.workers.dev
   curl -sS -w '\nHTTP %{http_code}\n' "$base/api/market?collectionId=opunk&start=0&limit=1" -H 'Origin: https://demro-labs.github.io'
   curl -sS -w '\nHTTP %{http_code}\n' "$base/api/market?collectionId=pokedex&start=0&limit=1" -H 'Origin: https://demro-labs.github.io'
   curl -sS -w '\nHTTP %{http_code}\n' "$base/api/auth/session?site=punks" -H 'Origin: https://demro-labs.github.io'
   curl -sS -w '\nHTTP %{http_code}\n' "$base/api/auth/session?site=pokedex" -H 'Origin: https://demro-labs.github.io'
   curl -sS -w '\nHTTP %{http_code}\n' "$base/api/runes/balance-list?address=$TEST_FRACTAL_ADDRESS&start=0&limit=1" -H 'Origin: https://demro-labs.github.io'
   ```

   La vérification des Runes doit être une lecture seule (`GET`), limitée à une page. Les routes `/api/runes/balance-list` et `/api/runes/balance` restent fixées à UniSat Fractal; elles ne doivent pas devenir un proxy générique et ne diffusent aucune transaction.

3. Repérer si l’incident suit immédiatement un déploiement ou touche aussi les services amont. Une réponse `503` du Worker n’est pas, à elle seule, une raison de republier du code.

## 2. Régression liée à une version Worker

Le Durable Object SQLite `AuthStorage` a déjà été créé en Production. En cas de régression d’un futur déploiement, choisir dans **Cloudflare Dashboard → Workers & Pages → `fractal-ordinal-live` → Deployments** la dernière version saine **postérieure à cette migration**, puis revenir à cette version :

```bash
pnpm dlx wrangler@4.150.0 rollback <VERSION_ID_SAINE> \
  --name fractal-ordinal-live \
  --message "incident: retour à la version post-migration validée" \
  --yes
```

**Ne pas revenir à une version antérieure à la création du Durable Object.** Cloudflare traite les changements de cycle de vie des Durable Objects comme atomiques et ne permet pas les déploiements progressifs ou les rollbacks qui traversent ce changement. Pour le tout premier déploiement de la migration, le bon filet de sécurité était dry-run + test local `workerd` + vérification Production immédiate; si le code de cette première migration avait été défectueux, il aurait fallu corriger vers l’avant en gardant la classe `AuthStorage`.

Après tout rollback, relancer les quatre requêtes de la section 1, puis vérifier les bindings `AUTH_STORAGE` et `UNISAT_API_KEY` sans lire ni imprimer la valeur du secret.

## 3. Panne UniSat, Fractal ou Mempool

- Consulter les avertissements Worker en direct :

  ```bash
  pnpm dlx wrangler@4.150.0 tail fractal-ordinal-live --status error
  ```

- Contrôler le statut Cloudflare et celui des API amont avant de changer le code. Dans GitHub Actions, ouvrir le run **Deploy Cloudflare Worker** et lire `Verify Cloudflare bindings and both production apps` ainsi que les étapes Wrangler.
- Les frais ont déjà deux sources (UniSat et Mempool); si les deux échouent, la route renvoie `503` plutôt que d’utiliser un tarif périmé. Les données marché/solde utilisent déjà un cache edge court pour l’affichage; un cache éventuel n’est jamais une preuve de disponibilité d’un UTXO ni une source d’autorisation pour dépenser.
- Les routes qui ont besoin du secret UniSat doivent continuer à passer par le Worker. **Ne pas basculer le navigateur directement vers une API protégée et ne jamais exposer la clé dans le frontend.** Ne pas relancer automatiquement une création de commande après un timeout ambigu; d’abord déterminer si UniSat a accepté la commande afin d’éviter les doublons.
- Les limites de requêtes et quotas dépendent de l’offre et de l’usage réels du compte. Vérifier **Workers & Pages → Analytics/Usage**; ne pas supposer qu’un seuil générique cité par Gemini s’applique au compte.

## 4. Vérifier logs, placement et déploiement

- `wrangler tail` suit les événements en direct. La configuration échantillonne les logs applicatifs à 10 % et désactive les journaux d’invocation afin de ne pas enregistrer les URL de requête contenant des adresses de wallet; les journaux peuvent donc ne pas contenir chaque requête.
- Smart Placement peut prendre jusqu’à 15 minutes de trafic pour choisir un emplacement. Examiner les métriques Cloudflare et l’en-tête `cf-placement`; ne pas traiter `local-XXX` pendant la période d’analyse comme une panne.
- Pour l’historique des runs GitHub :

  ```bash
  gh run list --repo Demro-Labs/ordinal-punks-collection
  gh run view <RUN_ID> --repo Demro-Labs/ordinal-punks-collection --log-failed
  ```

- L’étape de vérification post-déploiement utilise un POST Inscribe `text/plain` qui doit être rejeté `415` avant tout accès fournisseur ou création de commande. **Ne jamais tester en créant une vraie commande ou en diffusant une transaction.**

## 5. Connexion et preuve de propriété BIP-322
- Le sign-in du dashboard accepte `BITCOIN_MAINNET` et `FRACTAL_BITCOIN_MAINNET` pour Punks et Pokédex. Le challenge, le message signé et la session portent le réseau exact; une signature de login ne donne aucun droit de dépense.

- Les clients mobiles Punks et Pokédex appellent `/api/auth/ownership/challenge`, puis `/api/auth/ownership/verify`, après revue du reçu et avant toute approbation UniSat de transaction. La preuve est liée au site, à l’adresse, au réseau et au contexte de l’opération; elle expire rapidement et n’ouvre aucune session.
- Ces routes valident le contrôle de la clé, mais ne signent, ne diffusent et n’autorisent jamais un paiement ou transfert. L’approbation transactionnelle UniSat reste séparée et obligatoire. Les transferts BRC-20 classique et BRC20-Prog exigent aussi une preuve BIP-322 fraîche sur desktop et mobile; les autres parcours desktop existants ne sont pas modifiés par cette intégration.
- Après tout changement du Worker, exécuter `node --test workers/fractal-ordinal-live.test.mjs` et `bash scripts/smoke-worker-runtime.sh`. Le smoke vérifie les challenges Bitcoin et Fractal pour les deux sites, sans demander de signature ni créer de transaction.
- La vérification Production appelle les mêmes challenges sans signature, puis contrôle leur préflight CORS. Ne pas utiliser un vrai wallet ou une vraie opération pour vérifier ces routes.

## 6. Prévention et limites connues

- Toute modification passe par le dry-run Wrangler, le démarrage `workerd` local, les contrôles CI et les vérifications post-déploiement Punks/Pokedex.
- Le même Worker sert les deux sites; ne pas créer un Worker `production` séparé ni une deuxième base `AuthStorage` depuis le dépôt Pokedex.
- Ne pas activer une règle WAF de zone supposée couvrir `workers.dev`; cette API est sur le domaine `workers.dev` et n’expose pas de route générique `/api/fractal/broadcast`. Les inscriptions utilisent `/api/inscribe/order`; les envois on-chain ne sont pas relayés par une route broadcast générique.
- Ne pas configurer un fallback frontend direct ou un endpoint RPC d’exemple non validé. Une panne doit afficher un état dégradé explicite, préserver les garde-fous de signature/CORS et renvoyer une erreur sûre.
- Le health-check facultatif BRC2.0 requiert un endpoint de confiance configuré uniquement côté Worker : `wrangler secret put BRC20_PROG_RPC_URL`, et si nécessaire `BRC20_PROG_RPC_USER` / `BRC20_PROG_RPC_PASSWORD`. L’URL doit être HTTPS; les identifiants ne doivent jamais être encodés dans l’URL ou placés dans Git. Il appelle uniquement `eth_blockNumber` et **ne valide pas l’identité de l’indexeur, n’indexe pas les soldes, ne crée aucune inscription et n’active pas les appels BRC2.0**. Sans endpoint, la route renvoie `503` de façon attendue.
- Le panneau BRC2.0 actuel prépare uniquement un JSON deploy/call. Ne pas le présenter comme une exécution complète : la seconde transaction vers `OP_RETURN "BRC20PROG"` n’est pas encore construite par UniSat `sendInscription` (qui attend une adresse ordinaire). Ne jamais contourner cette limite par un destinataire improvisé.
- Recommandation non activée dans ce changement : créer dans Cloudflare Notifications une alerte de taux d’erreurs 5xx et la relier au canal d’astreinte choisi par le propriétaire du compte. Ne pas inventer un destinataire ou un webhook sans son choix.

## Sources

- [Cloudflare — placement](https://developers.cloudflare.com/workers/configuration/placement/)
- [Cloudflare — déploiements progressifs avec Durable Objects](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/)
- [Cloudflare — rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [Cloudflare — Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
