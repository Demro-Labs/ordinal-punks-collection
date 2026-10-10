# Transfert Ordinal expérimental par PSBT

## État

Ce chemin reste **désactivé par défaut** dans `UniSatWalletConnect.tsx` (`CUSTOM_PSBT_TRANSFER_ENABLED = false`). Le flux UniSat `sendInscription` reste le seul flux actif. Ne pas modifier ce drapeau avant la validation wallet/Mempool décrite plus bas. Aucun PSBT n’a été signé et aucune transaction n’a été diffusée pendant le développement.

Le Worker Cloudflare existant `fractal-ordinal-live` utilise toujours le secret de liaison `UNISAT_API_KEY`; sa valeur n’est ni lue ni envoyée au navigateur. La route `/api/spendable-utxos` doit maintenant attester, pour chaque sortie retournée, une vérification des actifs par outpoint. La clé UniSat sert uniquement aux lectures de l’indexeur; elle ne permet ni de contourner la politique dust, ni de diffuser une transaction.

## Construction et garde-fous

- L’inscription sélectionnée reste l’entrée 0. Son offset sat est extrait de `txid:vout:offset` et contrôlé contre la valeur réelle de la sortie source.
- L’inscription est routée vers la sortie 0 avec au moins 1 200 sats, ou `offset + 1` si le sat marqué se trouve plus loin dans la sortie.
- Un UTXO de frais doit être présent à la fois dans `getBitcoinUtxos` du wallet actif et dans le proxy Cloudflare de l’API UniSat `available-utxo-data`.
- **Cas d’un actif explicitement déverrouillé dans UniSat :** la liste `available-utxo-data` seule n’est plus considérée comme preuve suffisante. Avant de retourner un candidat, le Worker consulte l’API UniSat de l’outpoint `/v1/indexer/utxo/{txid}/{vout}` pour vérifier l’état dépensé et les inscriptions, puis `/v1/indexer/runes/utxo/{txid}/{vout}/balance`; sur Fractal, il consulte aussi `/v1/indexer/alkanes/utxo/{txid}/{vout}/balance`. Une sortie qui porte une inscription, un Rune ou un Alkane est écartée même si elle a été déverrouillée manuellement. Les réponses doivent correspondre à l’adresse, l’outpoint, la valeur et le script attendus, être confirmées et explicitement vides pour les actifs concernés.
- Le Worker ne marque `protocolAssetsChecked: true` qu’après ces vérifications. Le client exige cette attestation; une route ancienne, une réponse absente, incomplète, malformée ou une panne d’indexeur arrête le flux **fail-closed**, sans signer ni diffuser.
- Les pages de vérification sont plafonnées à 25 UTXO afin de borner les requêtes d’indexeur. Une page est paginée selon le nombre réellement inspecté.
- La vérification des inscriptions couvre aussi les inscriptions BRC-20 signalées par UniSat. Les indexeurs confirmés ci-dessus couvrent Runes sur Bitcoin et Fractal, ainsi qu’Alkanes sur Fractal. Les autres protocoles qui ne sont pas exposés par ces indexeurs n’ont pas été indépendamment validés; c’est une raison supplémentaire de laisser le drapeau désactivé.
- Plusieurs inscriptions partageant la sortie sélectionnée provoquent un refus. Toutes les sorties d’inscription connues dans le wallet sont exclues des frais.
- La monnaie n’est rendue que si elle vaut au moins 1 200 sats; sinon, le constructeur n’accepte qu’un frais sans monnaie borné et refuse tout autre cas.
- Les entrées de frais prises en charge sont Legacy P2PKH, Nested SegWit P2SH-P2WPKH, Native SegWit P2WPKH et Taproot P2TR key-path. Les scripts de dépense non pris en charge échouent sans émission de PSBT.
- Les scripts destinataires pris en charge sont Legacy P2PKH, P2SH, Native SegWit P2WPKH/P2WSH et Taproot P2TR. Ils sont dérivés localement puis comparés au résultat de validation Mempool propre au réseau.
- UniSat signe avec finalisation automatique désactivée. Avant toute diffusion, le client vérifie cryptographiquement les signatures ECDSA/Schnorr, finalise localement, puis compare l’ordre et les métadonnées des entrées, les champs de transaction, les scripts et montants de sortie, les limites dust, la comptabilité des frais et le taux réel après calcul de la taille virtuelle. Le compte, la clé publique et le réseau sont revérifiés avant et après la signature ainsi qu’avant la diffusion.
- La diffusion, si le flux était ultérieurement approuvé, utiliserait uniquement l’endpoint Mempool du réseau Bitcoin ou Fractal actif.

## Validation réalisée

Les tests hors ligne couvrent des signatures de test réelles et la finalisation des quatre styles d’entrée; les sorties destinataires Legacy, Nested/Native SegWit, P2WSH et Taproot; les offsets d’inscription; les seuils dust; les inscriptions multiples; l’exclusion d’une entrée inscrite; la propriété de script; le rejet d’une signature altérée; et le refus d’une attestation d’actifs manquante ou fausse. Commandes :

```sh
pnpm exec vitest run client/src/lib/ordinal-transfer-psbt.test.ts client/src/lib/custom-ordinal-transfer.test.ts
pnpm check
pnpm build
```

La revue wallet/Mempool réalisée était strictement en lecture seule : les pages UniSat Bitcoin et Fractal ainsi que des sorties confirmées et les frais recommandés Mempool des deux réseaux ont été consultés. Aucun PSBT n’a été signé, aucun UTXO n’a été déverrouillé et aucune transaction n’a été diffusée. L’appel sandbox direct au Worker avait précédemment été bloqué par la protection Cloudflare; le test d’intégration depuis les origines autorisées des sites reste à faire. Le binding `UNISAT_API_KEY` a été confirmé par son nom seulement.

## Vérifications manuelles encore requises avant activation

1. Depuis l’origine autorisée d’un site, vérifier que le Worker renvoie `protocolAssetsChecked: true` sur des UTXO ordinaires des deux réseaux, et qu’il exclut réellement un outpoint porteur de Rune ainsi qu’un outpoint porteur d’Alkane sur Fractal après son déverrouillage UniSat.
2. Vérifier des cas avec inscription/BRC-20 et confirmer qu’ils sont écartés. Ne pas utiliser d’actif réel pour signer ou diffuser un essai.
3. Sur des UTXO de test sans actifs, contrôler dans UniSat la signature (sans diffusion) des entrées P2PKH, P2SH-P2WPKH, P2WPKH et P2TR, sur Bitcoin et Fractal; confirmer `signPsbt(autoFinalized: false)` et le paramètre Taproot `useTweakedSigner` pour la version UniSat ciblée.
4. Relire chaque outpoint, valeur/script source, offset, destination, monnaie, frais/vsize, signatures et réseau choisi. Vérifier les règles relay/dust courantes de chaque mainnet avant toute activation.
5. Garder `CUSTOM_PSBT_TRANSFER_ENABLED = false` jusqu’à la réussite documentée des étapes ci-dessus et une approbation explicite distincte.

## Références

- [UniSat OpenAPI — règles de solde et UTXO BTC](https://github.com/unisat-wallet/unisat-dev-docs/blob/master/open-api/btc-balance-utxo.md)
- [UniSat — UTXO Bitcoin mainnet](https://docs.unisat.io/developer-support/open-api-documentation/api-for-bitcoin/general/addresses/get-btc-utxo)
- [UniSat — UTXO Fractal mainnet](https://docs.unisat.io/developer-support/open-api-documentation/api-for-fractal-bitcoin/general/addresses/get-btc-utxo)
- [UniSat — API indexeur Runes](https://github.com/unisat-wallet/unisat-dev-docs/blob/master/open-api/auto-generated/docs/runes-indexer.md)
- [UniSat — API indexeur Alkanes](https://github.com/unisat-wallet/unisat-dev-docs/blob/master/open-api/auto-generated/docs/alkanes-indexer.md)
- [UniSat — API wallet manage-assets](https://github.com/unisat-wallet/unisat-dev-docs/blob/master/wallet-api/api-docs/manage-assets.md)
- [Mempool — API REST](https://mempool.space/docs/api/rest)
