# Worker `fractal-ordinal-live`

Ce Worker sert les deux applications GitHub Pages, Ordinal Punks et Fractal Pokédex. Le module de routes d’authentification est `auth-bip322.js`; le point d’entrée est `fractal-ordinal-live.js`.

## Build et contrôles

Depuis la racine du dépôt :

```sh
pnpm check
pnpm build
pnpm exec vitest run
node --test workers/fractal-ordinal-live.test.mjs
pnpm exec esbuild workers/fractal-ordinal-live.js --bundle --platform=browser --format=esm --target=es2022 --minify --outfile=/tmp/fractal-ordinal-live-bundle.mjs
node --check /tmp/fractal-ordinal-live-bundle.mjs
```

Le bundler doit produire un seul module ESM `worker.js` qui contient `handleWalletAuth` et exporte `AuthStorage`.

## Métadonnées Cloudflare pour le déploiement

Lors de l’upload de la version du Worker `fractal-ordinal-live`, inclure dans `metadata` le module principal, le binding SQLite, l’export déclaratif, et conserver tous les bindings `secret_text` existants :

```json
{
  "main_module": "worker.js",
  "usage_model": "standard",
  "compatibility_flags": [],
  "bindings": [
    {
      "type": "durable_object_namespace",
      "name": "AUTH_STORAGE",
      "class_name": "AuthStorage"
    }
  ],
  "exports": {
    "AuthStorage": {
      "type": "durable-object",
      "storage": "sqlite"
    }
  },
  "keep_bindings": ["secret_text"]
}
```

Le compte Cloudflare provisionne la nouvelle classe SQLite à son premier déploiement déclaratif. Ne pas déclarer simultanément une liste de migrations legacy : Cloudflare ne permet pas de mélanger les migrations impératives et `exports` dans une même configuration Worker.

Le réglage production existant ne fournit actuellement aucune `compatibility_date` explicite; ne pas en inventer une pour cet ajout. Garder aussi le mode d’utilisation `standard`, les flags vides et les bindings `secret_text` existants. Le secret UniSat reste exclusivement dans le binding Cloudflare `UNISAT_API_KEY` : ne jamais l’inclure dans le code, les métadonnées, les journaux ou les réponses API. Vérifier après déploiement le **nom et le type** du binding, pas sa valeur.

## Déploiement sûr et retour arrière

1. Téléverser un Worker compilé et testé dans l’API Cloudflare Workers Versions, avec les métadonnées ci-dessus et `keep_bindings: ["secret_text"]`.
2. Confirmer que l’upload expose l’export `AuthStorage` de type Durable Object SQLite et le binding `AUTH_STORAGE`.
3. Créer le déploiement Cloudflare à 100 % vers la nouvelle version. Le dernier Worker actif avant cette fonctionnalité était la version `38`; conserver son identifiant de version renvoyé par l’API comme cible de retour arrière, sans la supprimer.
4. Vérifier `OPTIONS`, `POST /api/auth/challenge`, `POST /api/auth/verify`, `GET /api/auth/session` et `POST /api/auth/logout` sur les deux valeurs `site` (`punks`, `pokedex`). Utiliser un wallet de test contrôlé ou le vecteur public de test de la bibliothèque; toujours révoquer les sessions de test après le contrôle.
5. Vérifier que le binding `UNISAT_API_KEY` est toujours de type secret, que les routes Inscribe existantes répondent, et que `MAX_INSCRIBE_FILES` reste à 1 000.

Les cookies d’authentification ne sont pas stockés dans `localStorage`. Les routes sont en `no-store`; le Worker ne conserve pas la signature BIP-322 ni le jeton de session en clair.
