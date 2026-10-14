# Ordinal Punks — transferts UniSat vérifiés et inscriptions de fichiers

## Parcours actif

### Transfert ordinal Bitcoin et Fractal sur desktop et mobile

Le desktop conserve le transfert natif UniSat `sendInscription` si le wallet l’expose, avec repli sur le PSBT vérifié si cette API manque. Sur UniSat Mobile et Fractal Bitcoin mainnet, le site utilise toujours le PSBT vérifié — même si le provider expose `sendInscription` — car la méthode native mobile a renvoyé une réponse incomplète (`toAddress` indéfini) dans le cas rapporté. Le transfert natif Bitcoin mobile reste inchangé; le PSBT vérifié sert de repli si l’API native manque.

1. Mempool valide l’adresse destinataire et fournit le taux de frais courant.
2. Le Worker Cloudflare récupère la liste de UTXO dépensables UniSat avec vérification explicite des inscriptions, Runes et Alkanes; le client recoupe ces UTXO avec ceux du wallet et contrôle les données de transaction auprès du Mempool du réseau sélectionné.
3. Sur desktop (et sur Bitcoin mobile si l’API native est exposée), UniSat construit, fait approuver et diffuse le transfert ordinal avec `sendInscription`; l’application contrôle le TXID et suit la transaction.
4. Sur Fractal mobile, l’application affiche la revue PSBT exacte du réseau, de l’inscription, du destinataire, des sorties, de la monnaie et des frais. Une action explicite ouvre `signPsbt` dans UniSat. Après approbation, le client vérifie le PSBT signé et le compte, la clé et le réseau avant de soumettre la transaction au Mempool Fractal.
5. Le Mempool sélectionné valide/rejette la soumission et diffuse la transaction PSBT; l’application suit le TXID.

Sur mobile, la page doit toujours être ouverte dans le navigateur intégré UniSat. Le chemin Fractal mobile requiert `getBitcoinUtxos`, `getPublicKey`, `signPsbt` et `getAccounts`; si l’une de ces méthodes manque, le site bloque le transfert au lieu de retenter le chemin natif. Sur desktop, le comportement `sendInscription` est conservé; le wallet doit exposer ces mêmes méthodes uniquement si l’API native n’est pas disponible et que le repli PSBT est requis.

Si l’issue de la diffusion est incertaine, une nouvelle tentative est verrouillée jusqu’à vérification de l’activité UniSat et de Mempool. Aucun PSBT n’est signé ou diffusé si la revue exacte est refusée ou si les contrôles d’actifs, de compte ou de réseau échouent.

### Inscription de fichier

Le panneau Inscribe File utilise le Worker Cloudflare pour créer et suivre les commandes UniSat Inscribe API V5; la clé `UNISAT_API_KEY` reste côté Worker et n’est pas exposée au navigateur. Le même endpoint est utilisé sur desktop et mobile. Avant le paiement, l’application vérifie le réseau de la commande, valide l’adresse de paiement avec le Mempool correspondant et récupère les frais courants. L’application ouvre `sendBitcoin(payAddress, amount, { feeRate })` dans UniSat Desktop ou Mobile; le wallet construit, présente, signe et diffuse le paiement après approbation. Le TXID retourné est contrôlé puis suivi dans Mempool. Ce paiement en BTC est distinct du transfert de l’inscription. La transaction de paiement est suivie dans Mempool et l’état de la commande est interrogé auprès du Worker.

### Envoi FB depuis le dashboard UniSat desktop et mobile

Le dashboard propose le même formulaire de transfert FB dans UniSat Desktop et dans le navigateur intégré UniSat Mobile. Le site valide le montant décimal et le convertit exactement en satoshis, vérifie l’adresse sur Mempool Fractal, affiche le taux `sat/vB` live, puis appelle `sendBitcoin(destinataire, satoshis, { feeRate })`. Un transfert FB exige `FRACTAL_BITCOIN_MAINNET`; si UniSat est sur un autre réseau, l’utilisateur peut demander le changement explicite via `switchChain`, lorsque cette méthode est exposée, ou sélectionner manuellement Fractal dans le wallet. UniSat présente toujours la transaction et recueille l’approbation. Le site contrôle le TXID retourné, enregistre un reçu local et suit l’état dans Mempool Fractal. Les changements de compte et de réseau réactualisent l’interface. Ce transfert de FB est distinct du transfert d’Ordinal et n’utilise pas la clé Cloudflare.

## Rôle de chaque service

- **Cloudflare Worker** : proxy UniSat Inscribe V5 et proxy UniSat Inscribe V5; il ne signe aucune transaction.
- **UniSat Desktop ou Mobile** : exécute `sendBitcoin` pour le paiement Inscribe; pour les transferts ordinaux, desktop conserve `sendInscription` si disponible, tandis que Fractal mobile signe le PSBT vérifié après la revue explicite. Bitcoin mobile conserve le chemin natif s’il est disponible.
- **Mempool** : valide les adresses, fournit les frais, vérifie les données des entrées, accepte ou rejette la soumission de transaction, la diffuse et en suit les confirmations. L’API publique ne constitue pas une approbation protocolaire préalable à la signature; les écrans de revue du site et d’UniSat restent essentiels.

## Vérification

Les tests unitaires du PSBT de transfert couvrent la revue exacte et les contrôles d’actifs; les tests UniSat couvrent les appels `sendInscription` et `sendBitcoin`, la validation des paramètres et le contrôle du TXID. La suite locale, le contrôle TypeScript, le build de production et `git diff --check` doivent passer avant publication. Aucun wallet réel ne doit signer et aucune transaction ne doit être diffusée pendant les tests; un essai séparé sur l’extension desktop et sur l’appareil UniSat Mobile reste requis.

## Secret Cloudflare

Le binding Worker `UNISAT_API_KEY` est un secret serveur. Sa valeur ne doit jamais être copiée dans le dépôt, le bundle frontend, les logs ou les outils de diagnostic. Le frontend appelle uniquement les endpoints publics du Worker.

## Références

- [Stratégie Gemini partagée pour UniSat et Fractal Bitcoin](https://share.gemini.google/qNr4Tdf7Amrv)
- [UniSat Wallet API](https://docs.unisat.io/developer-support/open-api-documentation/unisat-wallet)
- [Connexion à UniSat Mobile](https://docs.unisat.io/developer-support/open-api-documentation/unisat-wallet/connect-with-unisat-mobile-wallet)
- [UniSat Inscribe API V5](https://github.com/unisat-wallet/unisat-dev-docs/blob/master/open-api/auto-generated/docs/inscribe-v5.md)
- [Mempool REST API](https://mempool.space/docs/api/rest)
- [Mempool FAQ](https://mempool.space/docs/faq)
