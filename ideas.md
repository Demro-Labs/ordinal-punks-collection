# Direction artistique — Ordinal Punks Collection

## Trois pistes explorées

### Piste 1 — Inscription Ledger
**Très bref aperçu :** Un musée numérique éditorial inspiré des catalogues d’archives, avec papier ivoire, encre carbone et un accent cuivre. La collection est traitée comme un registre culturel plutôt qu’une simple grille NFT.

**Probabilité :** 0.07

### Piste 2 — Block 0 Terminal
**Très bref aperçu :** Une interface de terminal inspirée des consoles de nœuds Bitcoin, compacte et monochrome, avec des signaux rouge-orangé pour les interactions et les liens d’inscription.

**Probabilité :** 0.03

### Piste 3 — Fractal Field Notes
**Très bref aperçu :** Un carnet de terrain contemporain, plus lumineux et tactile, qui combine cartes indexées, annotations manuscrites et mosaïque de pixels pour raconter la collection sur Fractal Bitcoin.

**Probabilité :** 0.09

## Approche retenue — Inscription Ledger

### Design Movement
Éditorialisme brutaliste contemporain, croisé avec les codes visuels des inventaires de musées et des registres de collectionneurs. L’interface doit donner l’impression d’ouvrir un document d’archive vivant, précis et consultable.

### Core Principles
1. **L’archive avant le décor :** chaque image est accompagnée d’informations lisibles, hiérarchisées et vérifiables.
2. **Tension matière / pixel :** papier, grain et filets fins contrastent avec les punks pixelisés et les identifiants monospaces.
3. **Asymétrie utile :** la navigation, l’index de page et les filtres occupent des zones dédiées afin de libérer la galerie.
4. **Lien direct vers la chaîne :** l’inscription UniSat est toujours présentée comme la source primaire de chaque pièce.

### Color Philosophy
Le fond ivoire légèrement chaud évoque une fiche d’inventaire imprimée et évite l’esthétique crypto trop saturée. Le charbon porte la lecture longue, le gris pierre crée les séparations, et le cuivre oxydé sert de couleur propriétaire pour les appels à l’action et les liens Fractal. Cette couleur doit donner une sensation de métal marqué par le temps, pas de néon.

### Layout Paradigm
Une colonne latérale étroite contient le contexte, l’état de la collection et la navigation. Le contenu principal s’organise en grille dense mais respirante de cartes, avec un en-tête éditorial en deux zones : titre à gauche, métriques à droite. La page de détail d’un punk utilise une composition à deux colonnes : image monumentale et fiche technique verticale.

### Signature Elements
- Un motif de lignes de registre et de repères de coupe, appliqué dans les séparateurs et les fonds secondaires.
- Des numéros de pièce en grande taille, partiellement recadrés, comme dans une planche de catalogue.
- Des pastilles cuivre « View inscription » avec une petite flèche diagonale, réservées aux liens UniSat.

### Interaction Philosophy
Les interactions sont documentaires et immédiates. Survoler une carte révèle un déplacement de 2–4 px, une ombre courte et un filet cuivre ; cliquer sur l’ID ou le bouton d’inscription ouvre UniSat dans un nouvel onglet. Les contrôles de pagination restent sobres, avec un état actif très visible et une prise en charge complète du clavier.

### Animation
Les transitions doivent rester sous 240 ms, avec un ease-out net. Les cartes apparaissent par groupes avec une légère montée et une opacité progressive, uniquement lorsque `prefers-reduced-motion` l’autorise. Les images ne doivent pas zoomer agressivement : un déplacement de 1.015 maximum suffit. Les boutons répondent par une compression de 0.97 au clic.

### Typography System
- **Titres :** Space Grotesk, 600–700, pour une géométrie contemporaine qui dialogue avec les pixels.
- **Texte courant :** IBM Plex Sans, 400–500, pour les notices et les descriptions.
- **Données / identifiants :** IBM Plex Mono, 400–600, pour les IDs, compteurs, traits et numéros de page.
- Les grands titres sont courts, en casse normale, avec un interlettrage légèrement resserré. Les libellés secondaires sont en capitales espacées, jamais en texte décoratif inutile.

### Brand Essence
**Le catalogue de référence des 10 000 Ordinal Punks inscrits sur Fractal Bitcoin, pour les collectionneurs qui veulent voir, comprendre et vérifier chaque pièce au même endroit.**

**Personnalité :** documentée, tactile, précise.

### Brand Voice
Les titres sont courts et assurés. Les CTA sont concrets et orientés source primaire ; les microcopies parlent comme des annotations de catalogue, jamais comme des slogans crypto génériques.

Exemples :
- « Ten thousand inscriptions. One living index. »
- « Ouvrir la source UniSat »

### Wordmark & Logo
Le signe de marque est un carré ouvert composé de quatre angles pixelisés qui forment simultanément un « O » d’ordinal et un cadre d’archive. Il doit être utilisé comme symbole graphique autonome, sans texte intégré, en charbon sur fond ivoire ou en cuivre sur fond charbon.

### Signature Brand Color
**Copper Index — `#C8663D`**. Un cuivre terreux, assez distinctif pour signer les liens et états actifs, mais suffisamment mat pour rester cohérent avec un catalogue d’archives.

## Décisions de style

- Le site sera en français pour les explications et les contrôles, avec les libellés de source UniSat en anglais lorsque cela clarifie l’action.
- Le thème principal est clair, ivoire et charbon ; aucun dégradé violet ni interface néon ne sera utilisé.
- Les visuels fournis par l’utilisateur restent la source de vérité pour la collection. Les assets générés servent uniquement à l’identité visuelle, au décor et à l’icône de marque.
