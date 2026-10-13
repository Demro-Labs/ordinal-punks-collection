# Transfert Ordinal mobile Fractal par PSBT

## État de l’implémentation

Le correctif local branche le flux PSBT personnalisé **uniquement pour Fractal Bitcoin dans le navigateur intégré UniSat Mobile**. Le transfert Bitcoin mobile et les autres chemins natifs continuent d’utiliser `sendInscription`. Le site vérifie la présence des méthodes UniSat requises et refuse de se rabattre silencieusement sur l’ancien appel natif si `signPsbt` n’est pas disponible.

Avant la signature, une boîte de dialogue séparée affiche le réseau, l’inscription, le destinataire, les sorties destinataire et monnaie, le taux de frais estimé et le montant total des frais. L’utilisateur doit approuver cette revue, puis confirmer la signature dans UniSat. Après la signature, le client vérifie le compte, la clé publique et le réseau, contrôle cryptographiquement les signatures et les sorties, finalise localement, puis diffuse uniquement la transaction vérifiée vers l’API Mempool Fractal. Une erreur ou réponse de diffusion incertaine bloque les nouvelles tentatives jusqu’à vérification de l’activité UniSat et de Mempool.

Les entrées signalent l’opt-in RBF avec la séquence `0xfffffffd`. **Le site ne construit ni ne diffuse de remplacement et ne propose aucun bouton d’augmentation de frais.** RBF indique une possibilité de remplacement selon les règles de relais et de mempool; il ne garantit ni confirmation ni acceptation par tous les nœuds. Tout remplacement ultérieur doit passer par une action autorisée dans le wallet.

Le correctif Worker de la PR #117 est fusionné et déployé sur `fractal-ordinal-live`. Le contenu a été remplacé par l’endpoint Cloudflare `PUT .../workers/scripts/{script_name}/content`, documenté comme contenu-seul, sans changement de configuration ni de métadonnées. Le binding `UNISAT_API_KEY` est toujours présent (`secret_text`, noms/types seulement vérifiés); sa valeur n’a pas été lue ni copiée dans le client. Un GET non transactionnel de `spendable-utxos` avec une adresse de démonstration et les paramètres requis a répondu HTTP 200; aucun transfert réel n’a été signé ou diffusé. À l’inverse, un appel sans paramètres retourne un 503 générique, car la route transforme actuellement les erreurs de validation en indisponibilité amont; le client envoie bien `chain`, `address`, `cursor` et `size`. C’est une amélioration d’observabilité non bloquante, distincte du transfert.

## Protections et limites des contrôles d’actifs

Le Worker demande explicitement à UniSat d’inclure les UTXO low-fee (`withLowFee=true`), que `available-utxo-data` omet par défaut. Un UTXO low-fee n’est admissible que si l’indexeur confirme une hauteur positive et si le détail confirme `isSpent: false`; le statut low-fee est conservé, pas traité comme une preuve qu’il est non confirmé. Le Worker vérifie aussi l’adresse, le txid/vout, le script, la valeur, la présence des marqueurs RBF/low-fee et une liste d’inscriptions explicitement vide. Il interroge ensuite l’API officielle UniSat de solde Runes par outpoint sur Bitcoin et Fractal. Pour Fractal, il interroge également le solde Alkanes. Chaque réponse doit être explicitement un tableau vide; une erreur, une réponse absente ou malformée entraîne une erreur fermée et aucune attestation.

Le champ d’attestation `inscriptionsRunesAlkanesChecked: true` décrit **uniquement** ces contrôles. Une sortie confirmée marquée RBF peut être dépensée : le marqueur historique n’autorise pas le remplacement d’une transaction déjà confirmée. Les inscriptions (y compris BRC-20 signalées comme inscriptions par UniSat), Runes et Alkanes sont couvertes dans les limites des données renvoyées par leurs indexeurs. Les autres protocoles non vérifiés par ces endpoints ne sont pas certifiés sûrs par cette attestation; un UTXO connu pour porter un autre actif ne doit pas être utilisé comme entrée de frais.

La sortie portant l’inscription sélectionnée reste l’entrée 0. Le constructeur vérifie son outpoint et son offset à partir de la source, puis l’envoie au destinataire avec au moins 1 200 sats ou `offset + 1`, selon la position du sat inscrit. Les sorties de monnaie inférieures à 1 200 sats sont refusées. Les entrées de frais doivent être présentes à la fois dans les UTXO du wallet et dans la liste vérifiée par le Worker; les sorties contenant des inscriptions sont exclues.

Les styles de scripts pris en charge et les hypothèses d’entrée sont détaillés dans le code et les tests. Les signatures ECDSA/Schnorr, l’ordre des entrées, les scripts et montants de sortie, le seuil dust et la comptabilité des frais sont vérifiés avant toute diffusion. L’estimation de frais ne permet pas de contourner une politique dust ou les règles de relais du réseau.

## Tests et vérifications manuelles

Les tests hors ligne ne signent ni ne diffusent de transaction réelle. Ils utilisent des clés et UTXO de test, des réponses UniSat/Mempool simulées et couvrent notamment le contrôle de revue avant signature, le signal RBF dans chaque entrée, la vérification de signature, la diffusion après vérification, l’annulation sans signature et le refus des réponses Worker incomplètes ou porteuses de Runes/Alkanes.

Avant un transfert réel, il reste nécessaire de vérifier sur l’application UniSat ciblée que `signPsbt` est disponible dans son navigateur intégré et que l’écran UniSat présente les mêmes éléments. N’approuver qu’après comparaison du réseau, de l’inscription, du destinataire et des montants/frais. Aucun essai avec un actif réel n’est requis pour les tests logiciels.

## Références

- [UniSat Wallet API](https://docs.unisat.io/developer-support/open-api-documentation/unisat-wallet)
- [UniSat — connexion au portefeuille mobile](https://docs.unisat.io/developer-support/open-api-documentation/unisat-wallet/connect-with-unisat-mobile-wallet)
- [UniSat — schéma de l’indexeur Blockchain, dont l’état `isSpent`](https://github.com/unisat-wallet/unisat-dev-docs/blob/master/open-api/auto-generated/docs/blockchain-indexer.md)
- [UniSat — solde Runes par UTXO](https://github.com/unisat-wallet/unisat-dev-docs/blob/master/open-api/auto-generated/docs/runes-indexer.md)
- [UniSat — solde Alkanes par UTXO](https://github.com/unisat-wallet/unisat-dev-docs/blob/master/open-api/auto-generated/docs/alkanes-indexer.md)
- [Bitcoin Core — opt-in RBF](https://bitcoincore.org/en/faq/optin-rbf/)
- [Mempool — FAQ](https://mempool.space/docs/faq)
- [Cloudflare API — Replace Worker Script Content](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/update/) — précise que l’opération remplace le contenu du Worker sans toucher à sa configuration ni à ses métadonnées.
