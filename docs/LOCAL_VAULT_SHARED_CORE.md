# Noyau commun Ordi Wallet Local Vault

## Objectif

Maintenir un même contrat de sécurité pour BTC et Fractal Bitcoin dans les deux applications, sans copier des règles de transaction divergentes.

## Architecture cible

Le noyau doit être une bibliothèque TypeScript pure, sans accès réseau, DOM, stockage navigateur ou clés globales. Les applications fournissent les adaptateurs réseau et l’interface; le noyau décide si une transaction peut passer à l’étape suivante.

### Contrats obligatoires

1. **Réseau explicite** : chaque contexte de transaction est lié à `bitcoin` ou `fractal`; toute incohérence adresse/réseau/PSBT est rejetée.
2. **Classification UTXO fail-closed** : seules les sorties confirmées, vérifiées et sans actif de protocole peuvent payer les frais. Inscription, Rune, Alkane, BRC-20, actif inconnu, état d’indexeur incomplet ou donnée périmée = sortie protégée.
3. **Examen immuable** : créer un résumé de transaction à partir du PSBT non signé (entrées, valeurs, sorties, frais, réseau, type d’adresse); comparer ce résumé au PSBT signé avant finalisation.
4. **Signature locale uniquement** : les clés privées ne sont jamais passées à un Worker, un indexeur, un endpoint ou un logger.
5. **Validation cryptographique stricte** : vérifier que toutes les signatures requises sont présentes et valides avant finalisation; aucune finalisation ou diffusion si un contrôle échoue.
6. **Diffusion séparée** : le noyau renvoie une transaction brute signée; un adaptateur de diffusion distinct l’envoie au réseau et vérifie le TXID.
7. **Flux BRC-20 en deux étapes** : préparation de l’inscription TRANSFER puis envoi explicite de l’inscription, sans enchaînement automatique.
8. **Diagnostics typés** : erreurs stables et non sensibles pour réseau invalide, UTXO absent/non sûr, snapshot incomplet, frais insuffisants, PSBT modifié, signature invalide et diffusion échouée.

## Interfaces envisagées

- `NetworkId = "bitcoin" | "fractal"`
- `VaultErrorCode` : codes stables sans données secrètes.
- `SafeUtxoSnapshot` : réseau, horodatage, complétude de l’indexation et sorties vérifiées.
- `ReviewedTransaction` : empreinte des entrées/sorties et limites de frais validées.
- Adaptateurs séparés pour UniSat, les indexeurs, la signature et la diffusion.

## Migration

1. Porter les tests de sécurité communs dans les deux dépôts.
2. Implémenter le noyau pur et ses tests unitaires, sans appels réseau.
3. Adapter le flux Local Vault de chaque site au noyau en conservant les constructeurs BTC/Fractal propres à chaque protocole.
4. Vérifier les cas adverses : PSBT altéré, entrée inventée, sortie protégée, réseau inversé, données incomplètes, signature altérée et diffusion refusée.
5. Exécuter les tests et contrôles CI des deux dépôts avant toute fusion ou déploiement.

## Non-objectifs

- Ne jamais contourner un manque d’UTXO sûrs en relâchant les filtres.
- Ne jamais déplacer les clés privées vers le serveur.
- Ne pas diffuser automatiquement la deuxième étape BRC-20.
- Aucun déploiement ou changement de production dans cette proposition.
