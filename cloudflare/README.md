# Worker Turnstile historique (inutilisé par les sites)

Depuis la suppression de Turnstile des sites Ordinal Punks et Pokedex, ni leurs interfaces ni le Worker `fractal-ordinal-live` n’appellent le vérificateur décrit ici. L’endpoint d’inscription ne demande plus de session ni de preuve Turnstile.

La ressource Cloudflare autonome `turnstile-human-verification` et son code source sont conservés, mais elle est désormais inutilisée par ces deux sites. Elle n’a pas été supprimée ni reconfigurée, car elle pourrait être appelée par un autre consommateur. Ne pas la déployer comme dépendance de ces sites.

Le code historique et ses tests restent présents pour référence ou restauration explicite. Les bindings Cloudflare `TURNSTILE_SECRET` et `SESSION_SECRET` ne doivent jamais être ajoutés à ce dépôt ni affichés.
