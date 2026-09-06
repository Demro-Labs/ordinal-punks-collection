# Autonomisation GitHub Pages

- [x] Copier les 100 planches WebP optimisées dans le dépôt sous `client/public/assets/ordinal-punks/sheets/`.
- [x] Copier le manifeste complet dans `client/public/assets/ordinal-punks/collection-data.json`.
- [x] Copier les assets de marque générés nécessaires dans `client/public/assets/brand/`.
- [x] Remplacer les chemins `/manus-storage/` par des chemins relatifs compatibles avec GitHub Pages.
- [x] Ajouter une configuration de build Pages avec le bon `base` pour le dépôt.
- [x] Ajouter un workflow GitHub Actions de déploiement Pages.
- [x] Vérifier le nombre de fichiers, le build et les références d’assets.
- [ ] Commit et push de la version autonome sur GitHub.

## Correction GitHub Pages

- [ ] Copier le build Vite final à la racine du dépôt, car Pages utilise actuellement la source legacy `main /`.
- [ ] Ajouter `.nojekyll` pour empêcher Jekyll de traiter le build Vite.
- [ ] Vérifier que l’index racine et les assets publics répondent avec HTTP 200.
- [ ] Republier et confirmer que la page sert l’application Ordinal Punks plutôt que le README.
