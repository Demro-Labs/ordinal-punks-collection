# Authentification par signature UniSat — conception

## Statut

Spécification seulement : aucune connexion, session utilisateur ou signature de message n’est activée par ce document. L’authentification est indépendante des transactions, reçus d’inscription et transferts d’Ordinal.

## Flux recommandé

1. Le client mobile lit l’adresse et le réseau depuis `window.unisat`, puis demande au serveur un challenge pour cette adresse et `FRACTAL_BITCOIN_MAINNET`.
2. Le serveur génère un nonce cryptographiquement aléatoire (au moins 256 bits), conserve uniquement son empreinte, et crée un challenge lié à l’origine canonique du site, l’URI, l’adresse, le réseau, l’action `login`, un identifiant unique, l’heure d’émission et une expiration de cinq minutes. Le challenge est à usage unique.
3. Le client affiche le challenge complet et appelle `unisat.signMessage(challenge, "bip322-simple")`. L’utilisateur confirme la signature dans UniSat; aucune signature n’est demandée automatiquement au chargement de la page.
4. Le client envoie adresse, réseau, challenge et signature au serveur. Le serveur retrouve le challenge par identifiant, vérifie les valeurs, l’origine et l’expiration, puis vérifie cryptographiquement la signature BIP-322 contre l’adresse Bitcoin indiquée. Il consomme le nonce de façon atomique avant de créer une session.
5. Le serveur remet une session courte dans un cookie `HttpOnly`, `Secure`, `SameSite=Lax` (ou plus strict si compatible), avec rotation et mécanisme de révocation. Le client ne conserve ni clé privée ni signature réutilisable.

## Contrôles obligatoires

- Une signature seule n’est jamais un jeton de session et ne doit pas être acceptée deux fois.
- Refuser les nonces expirés, inconnus, déjà consommés, les domaines inattendus et les réseaux différents de celui du challenge.
- Comparer l’adresse au format canonique; vérifier le script/adresse réseau cible via une bibliothèque BIP-322 maintenue, et non par décodage maison.
- Limiter les challenges par adresse et par IP, éviter les messages contenant une instruction de transaction, un paiement ou une approbation de dépense.
- Prévoir un message explicite du type « Connexion à [origine] pour [adresse] sur Fractal Bitcoin. Aucun paiement ni transfert n’est autorisé. Nonce: … Expire: … ».
- Ne jamais demander, afficher, journaliser ou stocker la phrase de récupération, une clé privée ou un secret wallet.
- Les sessions ne doivent pas autoriser les opérations on-chain : chaque dépense doit continuer à exiger une action UniSat distincte et une confirmation transactionnelle.

## API à concevoir

- `POST /api/auth/challenge`: reçoit `{ address, network }`, renvoie `{ challengeId, message, expiresAt }`.
- `POST /api/auth/verify`: reçoit `{ challengeId, address, network, signature }`, consomme atomiquement le nonce après vérification, puis crée la session.
- `POST /api/auth/logout`: invalide la session côté serveur.

Ces routes restent à construire avec stockage serveur dédié (TTL et consommation atomique). Le stockage browser/localStorage existant pour les reçus de transactions ne doit pas être réutilisé pour les challenges ou sessions.

## Référence provider

UniSat documente `signMessage(msg, type)` et les types `ecdsa` et `bip322-simple`; la documentation indique que BIP-322 prend en charge les adresses Taproot (P2TR). Pour ces sites Fractal mobile, utiliser explicitement `bip322-simple`, puis vérifier côté serveur avec un vérificateur BIP-322 qui prend en charge le réseau/adresse visé.

## Références

- UniSat Wallet API: [sendBitcoin, provider events and wallet methods](https://docs.unisat.io/dev/unisat-wallet-api).
- UniSat signMessage: [API reference and signature formats](https://github.com/unisat-wallet/unisat-dev-docs/blob/master/wallet-api/api-docs/sign-message.md).
