# Ordinal Punks — transferts mobiles UniSat et inscriptions de fichiers

## Parcours actif

### Transfert ordinal Fractal sur mobile

Le parcours mobile Fractal ne dépend plus de `sendInscription`, qui renvoyait une réponse incomplète dans UniSat Mobile. Il réutilise le constructeur PSBT audité et testé :

1. Mempool valide l’adresse destinataire et fournit le taux de frais courant.
2. Le Worker Cloudflare récupère la liste de UTXO dépensables UniSat avec vérification explicite des inscriptions, Runes et Alkanes; le client recoupe ces UTXO avec ceux du wallet et contrôle les données de transaction auprès de Fractal Mempool.
3. L’application affiche une revue exacte du réseau, de l’inscription, du destinataire, des sorties, de la monnaie rendue et des frais. Le signataire doit confirmer cette revue avant d’ouvrir UniSat.
4. UniSat Mobile signe le PSBT après son propre écran d’approbation. Le client vérifie alors la transaction signée et revérifie le compte, la clé et le réseau avant de la soumettre à Fractal Mempool.
5. Fractal Mempool valide/rejette la soumission et diffuse la transaction; l’application vérifie le TXID puis suit son état dans Mempool.

Si l’issue de la diffusion est incertaine, une nouvelle tentative est verrouillée jusqu’à vérification de l’activité UniSat et de Mempool. Aucun PSBT n’est signé ou diffusé si la revue exacte est refusée ou si les contrôles d’actifs, de compte ou de réseau échouent.

### Desktop et Bitcoin mobile

Le parcours desktop n’est pas modifié : il conserve l’appel natif UniSat `sendInscription`. Le transfert Bitcoin sur mobile conserve également le parcours natif `sendInscription`; le PSBT Cloudflare décrit ci-dessus est limité au mobile Fractal.

### Inscription de fichier

Le panneau Inscribe File utilise le Worker Cloudflare pour créer et suivre les commandes UniSat Inscribe API V5; la clé `UNISAT_API_KEY` reste côté Worker et n’est pas exposée au navigateur. Le même endpoint est utilisé sur desktop et mobile. Avant le paiement, l’application vérifie le réseau de la commande, valide l’adresse de paiement avec le Mempool correspondant et récupère les frais courants. UniSat présente ensuite le paiement `sendBitcoin` pour approbation. La transaction de paiement est suivie dans Mempool et l’état de la commande est interrogé auprès du Worker.

## Rôle de chaque service

- **Cloudflare Worker** : proxy UniSat Inscribe V5 et source des UTXO de frais vérifiés; il ne signe aucune transaction.
- **UniSat Mobile** : présente l’approbation du PSBT et signe avec la clé du wallet.
- **Mempool** : valide les adresses, fournit les frais, vérifie les données des entrées, accepte ou rejette la soumission de transaction, la diffuse et en suit les confirmations. L’API publique ne constitue pas une approbation protocolaire préalable à la signature; les écrans de revue du site et d’UniSat restent essentiels.

## Vérification

Les tests unitaires du PSBT couvrent la revue exacte avant signature, le refus sans signature ni diffusion, les marqueurs de vérification des actifs, le contrôle des entrées/sorties et le broadcast RBF à Mempool. La suite locale, le contrôle TypeScript, le build de production et `git diff --check` ont passé sur la branche de correctif. Aucun wallet réel n’a signé et aucune transaction n’a été diffusée pendant ces tests; un essai sur l’appareil UniSat Mobile ciblé reste requis avant mise en production.

## Références

- [UniSat Wallet API](https://docs.unisat.io/developer-support/open-api-documentation/unisat-wallet)
- [Connexion à UniSat Mobile](https://docs.unisat.io/developer-support/open-api-documentation/unisat-wallet/connect-with-unisat-mobile-wallet)
- [UniSat Inscribe API V5](https://github.com/unisat-wallet/unisat-dev-docs/blob/master/open-api/auto-generated/docs/inscribe-v5.md)
- [Mempool REST API](https://mempool.space/docs/api/rest)
- [Mempool FAQ](https://mempool.space/docs/faq)
