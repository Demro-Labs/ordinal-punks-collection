# Authentification du wallet UniSat par BIP-322

## Statut et portée

Le dashboard UniSat d’Ordinal Punks expose maintenant le même parcours d’authentification sur mobile et desktop. Le composant `UniSatWalletAuth` demande explicitement une signature `bip322-simple`; aucune signature n’est déclenchée au chargement de la page.

Cette authentification prouve uniquement le contrôle d’une adresse. Elle ne constitue pas une autorisation de paiement, de transfert FB ou d’inscription, et n’accorde aucun droit de dépense. Chaque transaction continue d’exiger l’appel UniSat approprié et sa confirmation séparée.

## Parcours

1. Le client lit à nouveau l’adresse et le réseau UniSat avant de demander un challenge. `BITCOIN_MAINNET` et `FRACTAL_BITCOIN_MAINNET` sont acceptés; le message signé et la session restent liés au réseau effectivement choisi.
2. `POST /api/auth/challenge` crée un identifiant aléatoire de 256 bits, lié au site, à l’origine, à l’URI canonique, à l’adresse, au réseau et à une expiration de cinq minutes. La réponse fournit le message exact à examiner.
3. Après l’action explicite « Sign this challenge in UniSat », le client appelle `unisat.signMessage(message, "bip322-simple")`.
4. `POST /api/auth/verify` reçoit l’identifiant, l’adresse, le réseau et la signature. Le Worker reconstruit lui-même le message à partir de l’enregistrement serveur, vérifie BIP-322 avec `@exodus/bip322-js`, puis consomme le challenge et crée la session dans une transaction SQLite atomique du Durable Object.
5. La session est posée dans un cookie `HttpOnly`, `Secure`, `SameSite=None; Partitioned`, valable huit heures. Le client vérifie qu’il est effectivement renvoyé par `GET /api/auth/session?site=punks`; aucun secret ni signature réutilisable n’est enregistré dans le navigateur.

Le message signé inclut notamment le domaine, l’URI `https://demro-labs.github.io/ordinal-punks-collection/`, le réseau, l’adresse, l’action « Login; prove wallet control only », un nonce et les horodatages. Il indique explicitement qu’aucun paiement, transfert ou accord de dépense n’est autorisé.

## Routes Worker

- `POST /api/auth/challenge` — reçoit `{ site: "punks", address, network }`; renvoie `{ challengeId, message, expiresAt, network, site }`.
- `POST /api/auth/verify` — reçoit `{ site, challengeId, address, network, signature }`; vérifie et consomme le challenge, crée la session et pose le cookie.
- `GET /api/auth/session?site=punks` — renvoie la session associée au cookie ou `{ session: null }`.
- `POST /api/auth/logout` — reçoit `{ site: "punks" }`, révoque la session côté serveur et supprime le cookie.

Les réponses d’authentification sont `no-store`. CORS n’autorise que les origines configurées et active les credentials pour ces origines.

## Stockage et protections

- Le Durable Object `AuthStorage` utilise le stockage SQLite et les exports déclaratifs Cloudflare (`storage: "sqlite"`). La liaison Worker est `AUTH_STORAGE`.
- Le Durable Object ne conserve que l’empreinte SHA-256 du challenge et du jeton de session; le challenge stocke les métadonnées nécessaires et l’adresse publique. Il ne stocke ni le nonce en clair, ni la signature BIP-322, ni une clé privée.
- Les compteurs IP stockent une empreinte de l’IP limitée à une fenêtre de 15 minutes, jamais l’IP brute. Limites durables : 8 créations de challenge/15 min et 20 vérifications/15 min par IP; en plus, 6 challenges/heure par empreinte d’adresse. Les throttles en mémoire par isolate constituent une protection rapide supplémentaire.
- Chaque challenge expire après cinq minutes et n’est consommable qu’une seule fois. La consommation, la révocation des anciennes sessions du même site/adresse et la création du nouveau jeton sont atomiques.
- Les sessions sont isolées entre Punks (`__Host-demro-punks-auth`) et Pokédex (`__Host-demro-pokedex-auth`). Les dépenses on-chain restent indépendantes de ces sessions.
- La connexion et les preuves de propriété acceptent Bitcoin mainnet et Fractal Bitcoin mainnet pour les quatre formats UniSat: `1…` P2PKH, `3…` P2SH-P2WPKH, `bc1q` P2WPKH et `bc1p` P2TR à clé unique. Le Worker vérifie cryptographiquement chaque signature selon la convention BIP-322 d’UniSat: témoin BIP-322 simple pour P2WPKH/P2TR et signature ECDSA récupérable compatible pour P2PKH/P2SH-P2WPKH. La session stocke le réseau utilisé; une preuve de propriété ne crée pas de session.
- La limite actuelle de **1 000 fichiers par commande Inscribe** est conservée dans le Worker. Les autres limites de taille et de requête restent inchangées.
- Le secret UniSat existant demeure un binding `secret_text` nommé `UNISAT_API_KEY`; le déploiement préserve les bindings secrets sans lire ni remplacer leur valeur.

## Références

- [UniSat `signMessage` et format BIP-322](https://github.com/unisat-wallet/unisat-dev-docs/blob/master/wallet-api/api-docs/sign-message.md)
- [BIP-322](https://bips.dev/322/)
- [Cloudflare — Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- [Cloudflare — Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Exodus BIP-322 JavaScript](https://www.npmjs.com/package/@exodus/bip322-js)
