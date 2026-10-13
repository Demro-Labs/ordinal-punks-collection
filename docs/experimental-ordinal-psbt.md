# Ordinal Punks — transferts UniSat vérifiés et inscriptions de fichiers

## Parcours actif

### Transfert ordinal Bitcoin et Fractal sur desktop et mobile

Le transfert ordinal utilise maintenant le même parcours PSBT vérifié sur desktop et mobile; il ne dépend plus de `sendInscription` pour construire et diffuser la transaction.

1. Mempool valide l’adresse destinataire et fournit le taux de frais courant.
2. Le Worker Cloudflare récupère la liste de UTXO dépensables UniSat avec vérification explicite des inscriptions, Runes et Alkanes; le client recoupe ces UTXO avec ceux du wallet et contrôle les données de transaction auprès du Mempool du réseau sélectionné.
3. L’application affiche une revue exacte du réseau, de l’inscription, du destinataire, des sorties, de la monnaie rendue et des frais. Le signataire doit confirmer cette revue avant d’ouvrir UniSat.
4. UniSat Desktop ou UniSat Mobile signe le PSBT après son propre écran d’approbation. Le client vérifie alors la transaction signée et revérifie le compte, la clé et le réseau avant de la soumettre au Mempool sélectionné.
5. Le Mempool sélectionné valide/rejette la soumission et diffuse la transaction; l’application vérifie le TXID puis suit son état dans Mempool.

Sur mobile, la page doit toujours être ouverte dans le navigateur intégré UniSat. Sur desktop, l’extension UniSat fournit le même compte, la même clé et les mêmes méthodes `getBitcoinUtxos`, `getPublicKey`, `signPsbt` et `getAccounts`.

Si l’issue de la diffusion est incertaine, une nouvelle tentative est verrouillée jusqu’à vérification de l’activité UniSat et de Mempool. Aucun PSBT n’est signé ou diffusé si la revue exacte est refusée ou si les contrôles d’actifs, de compte ou de réseau échouent.

### Inscription de fichier

Le panneau Inscribe File utilise le Worker Cloudflare pour créer et suivre les commandes UniSat Inscribe API V5; la clé `UNISAT_API_KEY` reste côté Worker et n’est pas exposée au navigateur. Le même endpoint est utilisé sur desktop et mobile. Avant le paiement, l’application vérifie le réseau de la commande, valide l’adresse de paiement avec le Mempool correspondant et récupère les frais courants. Le Worker atteste les UTXO sûrs, puis l’application prépare un PSBT de paiement exact avec revue du montant, des frais et de la monnaie. UniSat Desktop ou Mobile signe après approbation; le client vérifie la transaction signée avant de la diffuser dans le Mempool. La transaction de paiement est suivie dans Mempool et l’état de la commande est interrogé auprès du Worker.

## Rôle de chaque service

- **Cloudflare Worker** : proxy UniSat Inscribe V5 et source des UTXO de frais vérifiés; il ne signe aucune transaction.
- **UniSat Desktop ou Mobile** : présente l’approbation du PSBT et signe avec la clé du wallet.
- **Mempool** : valide les adresses, fournit les frais, vérifie les données des entrées, accepte ou rejette la soumission de transaction, la diffuse et en suit les confirmations. L’API publique ne constitue pas une approbation protocolaire préalable à la signature; les écrans de revue du site et d’UniSat restent essentiels.

## Vérification

Les tests unitaires du PSBT couvrent la revue exacte avant signature, le refus sans signature ni diffusion, les marqueurs de vérification des actifs, le contrôle des entrées/sorties et le broadcast RBF à Mempool. La suite locale, le contrôle TypeScript, le build de production et `git diff --check` doivent passer avant publication. Aucun wallet réel ne doit signer et aucune transaction ne doit être diffusée pendant les tests; un essai séparé sur l’extension desktop et sur l’appareil UniSat Mobile reste requis.

## Secret Cloudflare

Le binding Worker `UNISAT_API_KEY` est un secret serveur. Sa valeur ne doit jamais être copiée dans le dépôt, le bundle frontend, les logs ou les outils de diagnostic. Le frontend appelle uniquement les endpoints publics du Worker.

## Références

- [UniSat Wallet API](https://docs.unisat.io/developer-support/open-api-documentation/unisat-wallet)
- [Connexion à UniSat Mobile](https://docs.unisat.io/developer-support/open-api-documentation/unisat-wallet/connect-with-unisat-mobile-wallet)
- [UniSat Inscribe API V5](https://github.com/unisat-wallet/unisat-dev-docs/blob/master/open-api/auto-generated/docs/inscribe-v5.md)
- [Mempool REST API](https://mempool.space/docs/api/rest)
- [Mempool FAQ](https://mempool.space/docs/faq)
