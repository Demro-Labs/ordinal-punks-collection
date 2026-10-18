# Ordinal Punks — transferts UniSat vérifiés et inscriptions de fichiers

## Parcours actif

### Transfert Ordinal par Ordi Wallet Local Vault (Bitcoin et Fractal)

Depuis le panneau Live Ordinals du coffre déverrouillé, le transfert d’une inscription unique est préparé, signé et diffusé par Ordi Wallet localement, sur le site responsive (desktop/mobile) comme dans l’extension desktop. La clé privée ne quitte pas le vault. Avant la signature, le client exige une liste complète des inscriptions de l’adresse, recoupe la valeur de la sortie source avec la transaction brute, vérifie l’adresse destinataire et le taux de frais live, exclut les UTXO inscrits des entrées de frais et revalide tous les UTXO de frais confirmés et sans inscription/Rune/Alkane. Les inscriptions multiples dans la même sortie et toute liste d’indexeur incomplète sont refusées. La revue affiche le réseau, l’inscription, le destinataire, les entrées, les frais et le change; l’utilisateur confirme séparément la signature locale puis la diffusion irréversible. Le TXID est contrôlé et tout état de diffusion incertain bloque une nouvelle tentative dans l’interface.

### Transfert ordinal UniSat indépendant

Le desktop conserve le transfert natif UniSat `sendInscription` si le wallet l’expose, avec repli sur le PSBT vérifié si cette API manque. Sur mobile, Bitcoin et Fractal utilisent maintenant `sendInscription` natif dès que le provider UniSat Mobile expose la méthode. Le PSBT vérifié n’est pas utilisé comme fallback mobile, ni après une erreur native, pour éviter une transaction doublée si l’issue est incertaine. Ce parcours natif mobile a été activé le 15 octobre 2026 à la demande du propriétaire du dépôt; l’erreur historique `toAddress` indéfini reste à vérifier sur un véritable appareil UniSat.

1. Mempool valide l’adresse destinataire et fournit le taux de frais courant.
2. Le Worker Cloudflare confirme les UTXO de frais séparés sans inscription, Rune ni Alkane; la preuve BIP-322 mobile, l’adresse, le réseau, l’inscription, le destinataire et le taux de frais sont revérifiés avant l’action.
3. Sur desktop comme sur mobile lorsque `sendInscription` est exposé, UniSat construit, présente, signe et diffuse le transfert après approbation native; le site contrôle le TXID et suit la transaction.
4. Sur desktop seulement, si le provider ne propose pas `sendInscription`, le chemin PSBT vérifié peut encore être utilisé lorsque les méthodes nécessaires sont exposées. Le client vérifie le PSBT signé, le compte, la clé, le réseau et les sorties avant soumission au Mempool.

Sur mobile, la page doit être ouverte dans le navigateur intégré UniSat et le provider doit exposer `sendInscription`; si cette méthode manque, le site bloque le transfert. L’approbation UniSat demeure séparée de la preuve BIP-322 et du précontrôle Worker. Si une méthode native échoue ou si le retour ne contient pas un TXID valide, vérifiez UniSat et Mempool avant toute nouvelle tentative; aucun fallback automatique n’est lancé.

Si l’issue de la diffusion est incertaine, une nouvelle tentative est verrouillée jusqu’à vérification de l’activité UniSat et de Mempool. Aucun PSBT n’est signé ou diffusé si la revue exacte est refusée ou si les contrôles d’actifs, de compte ou de réseau échouent.

### Inscription de fichier

Le panneau Inscribe File utilise le Worker Cloudflare pour créer et suivre les commandes UniSat Inscribe API V5; la clé `UNISAT_API_KEY` reste côté Worker et n’est pas exposée au navigateur. Le même endpoint est utilisé sur desktop et mobile. Avant le paiement, l’application vérifie le réseau de la commande, valide l’adresse de paiement avec le Mempool correspondant et récupère les frais courants. Desktop appelle `sendBitcoin(payAddress, amount, { feeRate })`; mobile appelle la variante native UniSat Mobile avec `{ toAddress: payAddress, satoshis: amount, feeRate }`. Dans les deux cas, le wallet construit, présente, signe et diffuse le paiement après approbation. Le TXID retourné est contrôlé puis suivi dans Mempool; ce paiement est distinct du transfert de l’inscription.

### Envoi FB depuis le dashboard UniSat desktop et mobile

Le dashboard propose le même formulaire de transfert FB dans UniSat Desktop et dans le navigateur intégré UniSat Mobile. Le site valide le montant décimal et le convertit exactement en satoshis, vérifie l’adresse sur Mempool Fractal et affiche le taux `sat/vB` live. Desktop appelle `sendBitcoin(destinataire, satoshis, { feeRate })`; mobile utilise l’objet natif `{ toAddress, satoshis, feeRate }`. Un transfert FB exige `FRACTAL_BITCOIN_MAINNET`; si UniSat est sur un autre réseau, l’utilisateur peut demander le changement explicite via `switchChain` lorsque disponible, ou sélectionner Fractal manuellement. UniSat présente toujours la transaction et recueille l’approbation. Le site contrôle le TXID, enregistre un reçu local et suit l’état dans Mempool Fractal. Ce transfert n’utilise pas la clé Cloudflare.

### Frais Runes et erreur de précontrôle

Le transfert Runes appelle le provider natif `sendRunes` (arguments positionnels documentés) sur desktop et mobile. Sur mobile, le site exige en plus une preuve BIP-322 pour le contexte exact du transfert, puis un UTXO FB séparé, confirmé et sans inscription, Rune ou Alkane. Si le Worker indique `0 sats` sûrs après le scan maximal de 500 sorties et exige au moins 1 200 sats, aucun écran d’approbation n’a été ouvert et aucune transaction n’a commencé. Le propriétaire doit alimenter l’adresse Fractal connectée avec un UTXO distinct d’au moins le minimum affiché (1 200 sats minimum, davantage si la marge de frais l’exige), attendre sa confirmation puis relancer la vérification; le plafond d’inspection ne doit pas être contourné.

## Rôle de chaque service

- **Ordi Wallet Local Vault** : dérive et conserve les clés localement, prépare/revoit puis signe le transfert Ordinal en mémoire; aucune clé privée n’est envoyée au Worker ou à UniSat. La diffusion reste une étape distincte et explicite.
- **Cloudflare Worker** : proxy UniSat Inscribe V5, attestations d’UTXO et vérification des preuves BIP-322; il ne signe ni ne diffuse de transaction wallet.
- **UniSat Desktop ou Mobile** : construit, présente, signe et diffuse les appels natifs `sendInscription`, `sendBitcoin` et `sendRunes` après approbation. Le fallback PSBT Ordinals vérifié est réservé au desktop lorsque la méthode native manque.
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
