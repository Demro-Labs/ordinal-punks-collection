# Analyse du blocage de transfert mobile UniSat — Ordinal Punks

**Date :** 12 octobre 2026
**Dépôt analysé :** `Demro-Labs/ordinal-punks-collection`
**Commit `main` examiné :** `687b79c2e20a6d1a10cfc19e839292be37e8db05` — fusion de la PR #113, « Pause failing UniSat mobile transfers on Fractal ».

Le résultat principal est clair : **le code `main` bloque intentionnellement les transferts Fractal depuis tout navigateur mobile reconnu**. La PR #113 indique que le problème à l’origine de cette pause a été reproduit sur UniSat Mobile iOS 1.7.20 : la méthode native de transfert a renvoyé `toAddress` avec la valeur `undefined`. Le correctif présent dans le dépôt est un garde-fou; il ne corrige pas la méthode mobile UniSat elle-même. [1] [2]

Le workflow GitHub Pages associé au commit `687b79c…` est terminé avec succès. Cela confirme que GitHub a achevé le déploiement, mais pas que chaque navigateur mobile sert déjà les nouveaux fichiers plutôt qu’une version mise en cache. [3]

## Complément après réception du message exact

J’ai comparé le texte fourni avec le composant et le site public. Le message générique « Mobile transfer uses only UniSat’s native `sendInscription`… » correspond à la branche d’interface affichée quand `isMobileBrowser()` est vrai **et** que `mobileFractalTransferPaused` est faux. Dans le code actuel, cette variable vaut vrai si et seulement si le navigateur est mobile reconnu et `chain.enum === FRACTAL_BITCOIN_MAINNET`. En conséquence, si votre message vient du bundle public actuel, le wallet était probablement sur une chaîne autre que Fractal Bitcoin mainnet — par exemple Bitcoin mainnet. [2]

Cette interprétation est renforcée par une vérification publique en lecture seule : GitHub Pages a répondu HTTP 200, son HTML référençait `assets/index-BCFaSZ9G.js`, et ce bundle contient à la fois le libellé « Fractal mobile transfer paused » et le message générique cité. Le déploiement du commit courant avait aussi réussi. Cela n’exclut pas qu’un onglet du téléphone ait gardé une ancienne version en cache, mais l’application publique récupérée pendant cette analyse contient bien le garde-fou. [3] [15] [16]

Sur cette version actuelle, si le téléphone reconnaît le navigateur comme mobile et que la chaîne active est réellement `FRACTAL_BITCOIN_MAINNET`, la méthode `sendInscription` ne devrait pas être appelée par ce bouton. Le message `Cannot read property 'toAddress' of undefined` signifie donc qu’un appel natif a bien été tenté, mais il ne prouve pas si une transaction a été diffusée. Les explications les plus probables sont : chaîne active non-Fractal au moment du transfert, ancienne page encore chargée, ou transfert exécuté depuis un autre parcours que ce bouton. Je ne peux pas départager ces cas sans voir l’écran du wallet, ce que je n’ai pas fait.

**À faire maintenant : ne relancez pas le transfert.** Vérifiez d’abord l’activité UniSat et l’état de l’inscription sur UniScan; si vous avez un TXID, recherchez-le sur Mempool Fractal. Vérifiez ensuite le nom exact du réseau affiché dans UniSat. Si l’inscription visée est Fractal, il doit s’agir de Fractal Bitcoin mainnet, et non de Bitcoin mainnet. Après seulement, rouvrez l’URL de production dans le navigateur UniSat et vérifiez que le bouton indique « Fractal mobile transfer paused ». Si le wallet affiche Fractal mais que le site affiche encore le message générique, notez la version de l’application UniSat et confirmez que l’URL chargée est celle de GitHub Pages; n’envoyez ni adresse complète, ni clé API, ni donnée de signature.

## Précision sur RBF pour Fractal Bitcoin

Vous avez raison : la documentation officielle Fractal montre une option **RBF** dans un parcours UniSat/Bool Bridge précis, lors du transfert d’inscriptions de Fractal vers Bitcoin. Elle permet d’activer RBF après le choix de la sortie et du taux de frais pour accélérer cette transaction. C’est bien un exemple officiel concernant Fractal, mais c’est le flux Bool Bridge, pas le parcours mobile Ordinal Punks analysé ici. [17]

Le composant Ordinal Punks appelle `sendInscription(recipient, inscriptionId, { feeRate })`. La documentation de cette méthode expose `feeRate`, mais pas de paramètre `rbf`. Cela **ne démontre pas** que UniSat ne signale jamais RBF en interne; cela signifie qu’on ne peut pas déduire du code actuel que ce transfert précis l’a activé. L’article UniSat sur les transactions à frais très bas mentionne aussi des outils d’accélération RBF, sans établir que l’appel `sendInscription` de ce site en utilise un. [2] [5] [18]

RBF concerne le remplacement d’une transaction non confirmée dans le mempool par une transaction conflictuelle qui paie des frais plus élevés, sous réserve des règles appliquées par les nœuds. **RBF ne prouve pas qu’une transaction a été diffusée** : si l’appel a échoué avant la diffusion, il n’y a rien à accélérer; s’il a diffusé avant de renvoyer l’erreur `toAddress`, un TXID ou une entrée d’historique peut exister. [19] [20]

Pour votre cas, vérifiez l’historique UniSat et cherchez tout TXID sur le réseau correspondant. Si une transaction Fractal est en attente, n’utilisez qu’une action RBF explicitement proposée par le wallet/le parcours concerné après avoir vérifié que l’inscription reste dans la sortie destinataire attendue. **Ne créez pas manuellement une seconde transaction ni un PSBT de remplacement** : le bouton RBF de Bool Bridge ne garantit pas qu’un transfert `sendInscription` séparé soit remplaçable de la même manière. S’il n’y a ni TXID ni transaction dans l’historique, contrôlez l’emplacement actuel sur UniScan et ne concluez pas à une diffusion sur la seule base de l’erreur.

## Ce qui se passe dans le code

Dans `client/src/components/UniSatWalletConnect.tsx`, le parcours actif appelle `window.unisat.sendInscription(recipient, inscriptionId, { feeRate })`. Avant cet appel, il vérifie le compte et le réseau, charge des données d’inscription live, valide l’adresse avec l’instance Mempool du réseau, récupère un taux de frais, puis vérifie la présence de fonds/UTXO séparés pour les frais. [2]

Deux vérifications interrompent volontairement ce parcours si le navigateur est reconnu comme mobile et si `chain.enum` vaut `FRACTAL_BITCOIN_MAINNET` : une première avant les appels réseau, puis une autre après la relecture du réseau dans UniSat. L’interface désactive aussi le bouton et affiche « Fractal mobile transfer paused ». Les transferts Fractal depuis ordinateur et les transferts Bitcoin depuis mobile ne sont pas bloqués par ce garde-fou. Il s’applique toutefois à toutes les versions mobiles, pas seulement à iOS 1.7.20. [1] [2]

UniSat documente `sendInscription(address, inscriptionId, { feeRate })` dans son API `window.unisat`. Sa documentation mobile décrit séparément des liens profonds `unisat://request` pour `connect`, `switchChain`, `signMessage` et `signPsbt`, avec retour `unisat://response` et nonce. Elle ne documente pas, dans cette page mobile, une méthode mobile `sendInscription` ni le retour à utiliser pour cette opération. C’est un **écart de contrat à confirmer avec UniSat** : le site appelle une méthode documentée côté API wallet/provider dans un contexte mobile dont cette page officielle ne garantit pas la compatibilité. [4] [5]

Un deuxième point à valider concerne le bouton « Open this page in UniSat » : le dépôt utilise `https://app.unisat.cloud/request?method=openDapp…`. La documentation mobile consultée décrit plutôt `unisat://request?method=…` et ne décrit pas ce lien HTTPS avec `method=openDapp`. Cela ne prouve pas que le lien soit invalide, mais son comportement n’est pas vérifiable avec les documents officiels consultés. Il ne faut pas le remplacer à l’aveugle par un lien `connect` : ouvrir une dApp et autoriser un compte sont deux actions différentes. [2] [4]

## Erreurs et risques localisés

1. **Erreur native rapportée : `toAddress` indéfini.** La PR relie ce symptôme à l’appel de transfert natif d’UniSat Mobile iOS 1.7.20 dans le navigateur intégré. Il s’agit du constat consigné dans le dépôt; je ne l’ai pas reproduit sur un téléphone et les documents UniSat examinés ne confirment pas publiquement cet incident précis. [1]

2. **Blocage actuel attendu.** Si la page affiche « Fractal mobile transfer paused », aucun appel de transfert n’est censé être envoyé par ce bouton. Ce n’est pas une panne de la clé API : le parcours est arrêté avant `sendInscription`. Si le message `toAddress undefined` apparaît encore sur le site actuel, vérifier en premier la version des fichiers réellement chargés, l’agent utilisateur mobile détecté et la valeur effective de la chaîne. Le code ne reconnaît comme mobile que les agents contenant `Android`, `iPhone`, `iPad` ou `iPod`; le garde-fou dépend aussi de l’identifiant exact `FRACTAL_BITCOIN_MAINNET`. Une UA atypique ou une chaîne mal détectée pourrait donc passer à travers le blocage. [2] [3]

3. **Lien/contrat mobile non confirmé.** Le dépôt ouvre `method=openDapp`, puis s’attend à trouver `window.unisat` et à appeler `sendInscription`. Les pages mobiles officielles consultées décrivent des liens profonds `connect`/`switchChain`/`signPsbt`, mais ne certifient ni le lien `openDapp` du dépôt ni l’exposition de `sendInscription` dans le navigateur mobile. Cette différence peut concerner l’ouverture ou l’autorisation; elle n’explique pas à elle seule l’erreur `toAddress` une fois le wallet ouvert. [2] [4] [5]

4. **La clé UniSat Cloudflare ne signe pas le transfert.** Le Developer Center présente la clé comme un identifiant d’accès à l’Open API; l’API wallet traite séparément la connexion et les approbations de transaction. Dans ce dépôt, le Worker attend un binding secret nommé `UNISAT_API_KEY` pour ses lectures UniSat d’indexeur/frais. Le transfert actif appelle le provider UniSat du navigateur et ne transmet pas cette clé. **Ne pas publier, remplacer ou déplacer la clé pour tenter de réparer `toAddress`.** [5] [6] [7]

5. **Blocage serveur possible, mais distinct.** Le composant attend `fetchLiveInscription` avant d’appeler le wallet. Une erreur du Worker, un binding `UNISAT_API_KEY` absent/inopérant ou une origine non autorisée peut donc empêcher un transfert avant même l’ouverture de l’approbation UniSat. Le Worker n’autorise notamment que les origines déclarées dans `ALLOWED_ORIGINS`; l’origine GitHub Pages de production figure dans cette liste. C’est à vérifier seulement si le message est de type « Live UniSat data unavailable », erreur de frais ou erreur CORS, pas si l’écran affiche le garde-fou Fractal mobile. [2] [7]

6. **Documentation PSBT périmée et contradictoire.** `docs/experimental-ordinal-psbt.md` affirme qu’un transfert PSBT personnalisé est activé et remplace `sendInscription`. Pourtant, le composant actif appelle `sendInscription`, n’importe pas `sendOrdinalInscriptionWithCustomPsbt`, et indique dans l’interface qu’aucun PSBT personnalisé n’est utilisé. Cette note peut induire en erreur lors d’un futur dépannage. Le constructeur PSBT et ses tests existent, mais leur présence ne les rend pas actifs dans le parcours actuel. [2] [8]

7. **Avertissement peu visible.** Le message de pause se trouve à l’intérieur du panneau rendu seulement après sélection d’une inscription et saisie d’une adresse destinataire. Un utilisateur mobile peut donc ne pas comprendre immédiatement pourquoi le transfert est indisponible. C’est un problème d’interface, pas la cause native. [2]

8. **Petit défaut hors cause directe, lié aux deux réseaux.** Le composant accepte Bitcoin mainnet et Fractal mainnet, mais les liens « Live details » des cartes d’inscription pointent en dur vers `fractal.unisat.io`. L’outil de recherche UniScan, lui, construit une URL différente selon la chaîne. Cela peut afficher le mauvais explorateur quand le wallet est sur Bitcoin mainnet; cela ne bloque pas un transfert Fractal. [2]

UniScan est documenté comme explorateur Bitcoin/Fractal qui affiche notamment adresses, inscriptions et transactions, et non comme mécanisme d’autorisation ou de signature. Mempool fournit des données de réseau et des fonctions d’exploration/diffusion; il ne remplace pas l’approbation du wallet. Pour une inscription Fractal, les requêtes de chaîne doivent rester sur les endpoints Fractal (`mempool.fractalbitcoin.io` et les endpoints UniSat Fractal), distincts de ceux de Bitcoin. [7] [9] [10] [11]

## Plan de résolution recommandé

1. **Garder la pause et éviter les doublons.** Ne pas réessayer le même transfert sur Fractal mobile tant que le statut de l’inscription n’est pas établi. Vérifier l’activité UniSat, l’inscription/adresse sur UniScan et, si un TXID existe, la transaction sur l’explorateur Mempool Fractal. L’absence immédiate d’une transaction dans un explorateur ne suffit pas, à elle seule, à conclure qu’aucune diffusion n’a eu lieu. Bitcoin et Fractal doivent être vérifiés séparément. [7] [9] [10]

2. **Classer l’erreur par étape avant tout changement.** Noter uniquement le texte d’erreur non sensible, le modèle/OS du téléphone, la version de UniSat Mobile, le navigateur utilisé, le réseau affiché et si l’écran d’approbation UniSat s’est ouvert. Ne transmettre ni phrase de récupération, ni clé privée, ni clé API, ni données de signature. Si l’erreur est `toAddress undefined` après ouverture du wallet, la piste est le contrat natif mobile; si elle mentionne les données live, les frais ou CORS avant la fenêtre wallet, examiner plutôt le Worker.

3. **Faire confirmer le contrat mobile par UniSat avant de réactiver.** Comparer `openDapp`, l’injection éventuelle de `window.unisat` et `sendInscription` à la documentation mobile la plus récente ou à une confirmation UniSat. N’adopter un autre flux que s’il est officiellement décrit. La documentation mobile mentionne `signPsbt`, mais ne décrit pas complètement le parcours mobile de diffusion/confirmation; une migration PSBT ne doit donc pas être considérée comme un contournement prêt à l’emploi. [4] [5]

4. **Réactiver uniquement après correctif vérifiable.** Maintenir le blocage Fractal mobile jusqu’à une version UniSat corrigée ou une procédure officiellement prise en charge, puis la tester d’abord sans inscription de valeur sur un environnement/test wallet approprié. Si le wallet n’expose pas officiellement son numéro de version, ne pas inventer une détection automatique; faire de la réactivation une décision de version du site après test de non-régression. Conserver Bitcoin mobile et Fractal desktop comme cas séparés.

5. **Vérifier le Worker sans toucher au secret.** En lecture seule, confirmer que le Worker déployé attend bien le binding `UNISAT_API_KEY`, que ce binding existe sous ce nom et que le Worker/site sont ceux attendus. Ne pas afficher, copier, remplacer ou faire tourner la valeur. Cette vérification sert aux étapes de données live/frais; elle ne répare pas une erreur native de destination. [6] [7]

6. **Corriger l’interface et la documentation.** Le correctif initial affichait la pause mobile Fractal; la réactivation demandée retire ce blocage et utilise désormais un avertissement non bloquant. Les validations du wallet, du réseau, de l’inscription, du destinataire et de l’approbation finale UniSat restent actives, tout comme le verrou après résultat incertain. Des tests sur le provider mobile réel et sur appareil restent à faire. [21]

7. **Validation finale, sans diffusion mainnet.** Après toute modification ultérieure, exécuter `pnpm run check`, les tests du composant mobile, les tests unitaires et le build, puis confirmer le déploiement GitHub Pages. Aucun essai ne doit signer ou diffuser un transfert d’inscription de valeur sans nouvelle autorisation et vérification manuelle complète de la chaîne, de la destination et des frais.

## Mise à jour : transfert mobile Fractal réactivé

Le changement demandé supprime les deux refus spécifiques au transfert mobile Fractal et réactive le parcours natif UniSat `sendInscription` dans le navigateur intégré UniSat. Le bouton conserve les contrôles de contexte mobile, de réseau, d’inscription, d’adresse destinataire et de confirmation explicite; UniSat affiche toujours l’écran d’approbation final. L’avertissement « Fractal mobile transfer is enabled » n’est plus bloquant et rappelle le risque de réponse incomplète.

Si la réponse native est ambiguë (notamment `toAddress` indéfini ou TXID invalide), le verrou `sessionStorage` continue de bloquer une autre tentative jusqu’à la vérification manuelle de l’activité UniSat et du Mempool. Cette réactivation **ne corrige pas le défaut natif UniSat** : l’erreur peut toujours se produire. Vérifier l’activité et la chaîne avant de réessayer; aucune transaction n’a été signée ou diffusée pendant les tests locaux.

La PR #114 précédente a fusionné les garde-fous et la documentation au commit `b084873a65a49cc542c15fab1a2c0f0433537db3`; son workflow Pages a réussi. La page et le bundle de cette publication avaient été vérifiés en HTTP 200. [21] [22] [23] [24]

Cette réactivation n’ajoute pas de parcours RBF/PSBT et ne modifie pas Cloudflare. Ces éléments restent à traiter selon une spécification distincte. Aucun secret Cloudflare n’a été lu et aucune configuration Cloudflare n’a été modifiée.

## Vérifications locales effectuées

`pnpm run check` a réussi; les tests Vitest sélectionnés passent (33 tests), les tests Node mockés du Worker passent (15 tests) et `pnpm run build` a réussi après la réactivation. **Aucun de ces tests ne couvre le vrai provider UniSat sur mobile, le lien `openDapp`, ni l’erreur native `toAddress`.** Aucun appareil n’a été utilisé et aucune transaction n’a été signée ou diffusée. Ces résultats ne valident pas un futur parcours RBF/PSBT ni une modification Cloudflare.

## Références

[1]: https://github.com/Demro-Labs/ordinal-punks-collection/pull/113 "PR #113 — Pause failing UniSat mobile transfers on Fractal"
[2]: https://github.com/Demro-Labs/ordinal-punks-collection/blob/687b79c2e20a6d1a10cfc19e839292be37e8db05/client/src/components/UniSatWalletConnect.tsx "Code du parcours UniSat et des gardes mobile au commit analysé"
[3]: https://github.com/Demro-Labs/ordinal-punks-collection/actions/runs/38188269155 "GitHub Pages — déploiement du commit 687b79c2"
[4]: https://docs.unisat.io/developer-support/open-api-documentation/unisat-wallet/connect-with-unisat-mobile-wallet "UniSat Developer Center — Connect with UniSat Mobile Wallet"
[5]: https://docs.unisat.io/developer-support/open-api-documentation/unisat-wallet "UniSat Developer Center — UniSat Wallet API"
[6]: https://link.unisat.space/docs/dev-center/developer-center/unisat-open-api "UniSat Developer Center — Start building with UniSat API"
[7]: https://docs.unisat.io/products/uniscan-block-explorer "UniScan — Block Explorer"
[8]: https://github.com/Demro-Labs/ordinal-punks-collection/blob/687b79c2e20a6d1a10cfc19e839292be37e8db05/docs/experimental-ordinal-psbt.md "Note PSBT expérimentale du dépôt"
[9]: https://mempool.fractalbitcoin.io/docs/api/rest "Mempool Fractal — API REST"
[10]: https://docs.fractalbitcoin.io/getting-started/introduction "Fractal Bitcoin — Introduction"
[11]: https://developer.bitcoin.org/devguide/transactions.html "Bitcoin Developer Guide — Transactions"
[12]: https://github.com/bitcoin/bips/blob/master/bip-0174.mediawiki "Bitcoin Improvement Proposal 174 — Partially Signed Bitcoin Transaction Format"
[13]: https://github.com/Demro-Labs/ordinal-punks-collection/blob/687b79c2e20a6d1a10cfc19e839292be37e8db05/README.md "README du dépôt — rôle du Worker et conservation de la clé UniSat"
[14]: https://github.com/Demro-Labs/ordinal-punks-collection/blob/687b79c2e20a6d1a10cfc19e839292be37e8db05/workers/fractal-ordinal-live.js "Worker live — bindings et appels UniSat/Mempool"
[15]: https://demro-labs.github.io/ordinal-punks-collection/ "Application publique Ordinal Punks sur GitHub Pages"
[16]: https://demro-labs.github.io/ordinal-punks-collection/assets/index-BCFaSZ9G.js "Bundle JavaScript public contrôlé le 12 octobre 2026"
[17]: https://docs.fractalbitcoin.io/getting-started/how-to.../how-to-use-the-bool-bridge "Documentation Fractal Bitcoin — option RBF dans le parcours Bool Bridge"
[18]: https://docs.unisat.io/misc/articles/understanding-sub-1-sat-vb-bitcoin-transactions/what-happens-below-1-sat-vb-+-the-hidden-risks-of-sub-1-sat-vb-bitcoin-transactions "UniSat — risques de transactions à frais très bas et outils RBF"
[19]: https://bitcoincore.org/en/faq/optin_rbf/ "Bitcoin Core — Opt-in RBF FAQ"
[20]: https://bitcoinops.org/en/topics/replace-by-fee/ "Bitcoin Optech — Replace-by-fee"
[21]: https://github.com/Demro-Labs/ordinal-punks-collection/pull/114 "PR #114 — correctifs de sûreté transfert mobile UniSat"
[22]: https://github.com/Demro-Labs/ordinal-punks-collection/actions/runs/38192236961 "GitHub Actions — déploiement Pages après fusion de la PR #114"
[23]: https://demro-labs.github.io/ordinal-punks-collection/ "Site Ordinal Punks — page publique vérifiée après fusion"
[24]: https://demro-labs.github.io/ordinal-punks-collection/assets/index-Dx448svh.js "Bundle public contenant les correctifs de transfert mobile"
