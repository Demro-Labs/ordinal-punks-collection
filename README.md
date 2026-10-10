# Ordinal Punks Collection

Catalogue visuel des **10 000 Ordinal Punks** inscrits sur Fractal Bitcoin, avec consultation des métadonnées, galerie optimisée, données live UniSat et outils wallet.

## Fonctionnalités

- Galerie paginée des 10 000 inscriptions avec images optimisées en feuilles WebP.
- Recherche et consultation des métadonnées : inscription ID, nom, description, token ID, fichier et traits.
- Panneau de détail d’une inscription avec propriétaire, créateur et état de listing UniSat lorsque ces données sont disponibles.
- Chargement automatique des inscriptions détenues après connexion du wallet UniSat.
- Filtrage des inscriptions éligibles au transfert : les inscriptions et actifs protocolaires sont protégés contre une sélection accidentelle.
- Transfert sécurisé par PSBT avec contrôle de la sortie d’inscription et prévention des sorties dust.
- Chaque transfert nécessite une approbation explicite dans UniSat : aucune transaction n’est signée ou diffusée automatiquement par le site.
- Upload et inscription UniSat avec création d’ordre et approbation wallet.
- Marché live de la collection, alimenté par le Worker Cloudflare et l’API UniSat.
- Liens directs vers les pages UniSat de la collection et de chaque inscription.

## Wallet et transfert

Le bouton de connexion utilise l’extension UniSat. Après connexion, le site charge automatiquement les inscriptions du wallet connecté.

Le transfert utilise l’adresse destinataire saisie par l’utilisateur et sélectionne uniquement des inscriptions compatibles avec le transfert PSBT. Les UTXO de frais sont récupérés via la route sécurisée :

```text
GET https://fractal-ordinal-live.servostar23.workers.dev/api/spendable-utxos
```

Le Worker vérifie notamment l’adresse, le montant, le script, l’absence d’inscription et l’absence d’actifs protocolaires signalés. La politique dust du réseau ne peut pas être contournée par une clé API.

> Toujours vérifier l’adresse destinataire et le résumé affiché dans UniSat avant de signer.

## Upload et inscription

Le panneau d’inscription permet de préparer un fichier, de créer un ordre UniSat et de suivre son statut. La clé API UniSat reste côté Worker Cloudflare dans le secret `UNISAT_API_KEY` ; elle n’est jamais envoyée au navigateur.

L’utilisateur doit approuver le paiement et les opérations demandées directement dans UniSat.

## Architecture live

Le frontend appelle le Worker Cloudflare suivant :

```text
https://fractal-ordinal-live.servostar23.workers.dev
```

Routes principales utilisées par l’interface :

- `/api/market` — marché live de la collection ;
- `/api/live-inscription` — propriétaire, créateur et listing d’une inscription ;
- `/api/spendable-utxos` — UTXO de frais admissibles au transfert PSBT ;
- `/api/inscribe/order` — création et suivi des ordres d’inscription.

Les réponses live peuvent être partielles lorsque UniSat est temporairement indisponible. L’interface utilise des valeurs de repli et continue d’afficher les métadonnées locales.

## Développement local

```bash
pnpm install
pnpm run dev
```

Commandes de validation :

```bash
pnpm run check
pnpm run build
```

Le projet utilise React 19, Vite, Tailwind CSS 4 et TypeScript. Le serveur local peut être lancé après compilation avec :

```bash
pnpm run start
```

## Déploiement

Le site est déployé automatiquement sur GitHub Pages depuis `main` par le workflow inclus dans `.github/workflows/`.

URL de production :

```text
https://demro-labs.github.io/ordinal-punks-collection/
```

Vite utilise automatiquement la base `/ordinal-punks-collection/` lors du build GitHub Pages.

## Données et assets

Le dépôt contient le manifeste des inscriptions, les métadonnées locales, les feuilles WebP optimisées et les assets de marque sous `client/public/assets/`. Les données locales permettent de consulter la collection même lorsque les services live sont indisponibles.

## Sécurité et limites

- La clé UniSat n’est pas exposée dans le frontend.
- Les signatures et paiements restent sous le contrôle de l’utilisateur dans UniSat.
- Le site ne contourne pas les règles dust du réseau.
- Les données de marché, propriétaire et inscription dépendent de la disponibilité de l’API UniSat.
