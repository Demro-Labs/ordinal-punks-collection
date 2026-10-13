# Ordinal Punks — transferts UniSat vérifiés et inscriptions de fichiers

## Parcours actif

### Transfert ordinal Bitcoin et Fractal sur desktop et mobile

Le transfert ordinal utilise `sendInscription` natif UniSat sur desktop et mobile si le wallet l’expose; sinon, il utilise le parcours PSBT vérifié comme solution de repli.

1. Mempool valide l’adresse destinataire et fournit le taux de frais courant.
2. Le Worker Cloudflare récupère la liste de UTXO dépensables UniSat avec vérification explicite des inscriptions, Runes et Alkanes; le client recoupe ces UTXO avec ceux du wallet et contrôle les données de transaction auprès du Mempool du réseau sélectionné.
3. Si `sendInscription` existe, UniSat construit, fait approuver et diffuse le transfert ordinal nativement; l’application contrôle le TXID et suit la transaction.
4. Si cette méthode n’est pas exposée, l’application affiche la revue PSBT exacte du réseau, de l’inscription, du destinataire, des sorties, de la monnaie et des frais. Après approbation, le client vérifie le PSBT signé et le compte, la clé et le réseau avant de soumettre la transaction au Mempool sélectionné.
5. Le Mempool sélectionné valide/rejette la soumission et diffuse la transaction PSBT; l’application suit le TXID.

Sur mobile, la page doit toujours être ouverte dans le navigateur intégré UniSat. Sur desktop, l’extension UniSat peut utiliser `sendInscription`; si l’API manque, le wallet doit exposer `getBitcoinUtxos`, `getPublicKey`, `signPsbt` et `getAccounts` pour le repli PSBT.

Si l’issue de la diffusion est incertaine, une nouvelle tentative est verrouillée jusqu’à vérification de l’activité UniSat et de Mempool. Aucun PSBT n’est signé ou diffusé si la revue exacte est refusée ou si les contrôles d’actifs, de compte ou de réseau échouent.

### Inscription de fichier

Le panneau Inscribe File utilise le Worker Cloudflare pour créer et suivre les commandes UniSat Inscribe API V5; la clé `UNISAT_API_KEY` reste côté Worker et n’est pas exposée au navigateur. Le même endpoint est utilisé sur desktop et mobile. Avant le paiement, l’application vérifie le réseau de la commande, valide l’adresse de paiement avec le Mempool correspondant et récupère les frais courants. L’application ouvre `sendBitcoin(payAddress, amount, { feeRate })` dans UniSat Desktop ou Mobile; le wallet construit, présente, signe et diffuse le paiement après approbation. Le TXID retourné est contrôlé puis suivi dans Mempool. Ce paiement en BTC est distinct du transfert de l’inscription. La transaction de paiement est suivie dans Mempool et l’état de la commande est interrogé auprès du Worker.

## Rôle de chaque service

- **Cloudflare Worker** : proxy UniSat Inscribe V5 et proxy UniSat Inscribe V5; il ne signe aucune transaction.
- **UniSat Desktop ou Mobile** : exécute `sendBitcoin` pour le paiement Inscribe; pour les transferts ordinaux, exécute `sendInscription` si disponible, sinon signe le PSBT vérifié.
- **Mempool** : valide les adresses, fournit les frais, vérifie les données des entrées, accepte ou rejette la soumission de transaction, la diffuse et en suit les confirmations. L’API publique ne constitue pas une approbation protocolaire préalable à la signature; les écrans de revue du site et d’UniSat restent essentiels.

## Vérification

Les tests unitaires du PSBT de transfert couvrent la revue exacte et les contrôles d’actifs; les tests UniSat couvrent les appels `sendInscription` et `sendBitcoin`, la validation des paramètres et le contrôle du TXID. La suite locale, le contrôle TypeScript, le build de production et `git diff --check` doivent passer avant publication. Aucun wallet réel ne doit signer et aucune transaction ne doit être diffusée pendant les tests; un essai séparé sur l’extension desktop et sur l’appareil UniSat Mobile reste requis.

## Secret Cloudflare

Le binding Worker `UNISAT_API_KEY` est un secret serveur. Sa valeur ne doit jamais être copiée dans le dépôt, le bundle frontend, les logs ou les outils de diagnostic. Le frontend appelle uniquement les endpoints publics du Worker.

## Références

- [UniSat Wallet API](https://docs.unisat.io/developer-support/open-api-documentation/unisat-wallet)
- [Connexion à UniSat Mobile](https://docs.unisat.io/developer-support/open-api-documentation/unisat-wallet/connect-with-unisat-mobile-wallet)
- [UniSat Inscribe API V5](https://github.com/unisat-wallet/unisat-dev-docs/blob/master/open-api/auto-generated/docs/inscribe-v5.md)
- [Mempool REST API](https://mempool.space/docs/api/rest)
- [Mempool FAQ](https://mempool.space/docs/faq)
