# Ordinal Punks / Ledger

A visual catalogue for all 10,000 Ordinal Punks inscribed on Fractal Bitcoin. The interface presents 20 records per plate, exposes the supplied metadata for each punk, and links every inscription ID directly to its UniSat source page.

## What is included

The catalogue loads the supplied `inscriptions.json` data, including the inscription ID, name, description, token ID, file name and trait attributes. The 10,000 source PNGs are represented in optimized 100-tile WebP sheets so the browser only fetches the sheets needed for the current page. Each card provides a clickable inscription ID, a copper UniSat source badge and a full metadata record in the detail panel.

The collection source is [UniSat Fractal Bitcoin](https://fractal.unisat.io/market/collection?collectionId=opunk). Individual records use the direct URL format `https://fractal.unisat.io/inscription/{inscription_id}`.

## Local development

```bash
pnpm install
pnpm run dev
```

The project is a React 19 + Vite + Tailwind 4 static frontend. Type checking and the production build can be verified with:

```bash
pnpm run check
pnpm run build
```

## Design direction

The visual system follows **Inscription Ledger**: warm archive paper, charcoal ink, muted Copper Index accents, monospaced record fields and an asymmetric catalogue layout. The interface is deliberately documentary rather than marketplace-like, with UniSat treated as the primary source for verification.

## Source data

The source archive supplied for this project contains 10,000 1024×1024 PNG files and a 10,000-record JSON metadata file. The build pipeline used during preparation is documented outside the frontend source because the deployed interface consumes the optimized manifest and sprite sheets.

## Notes

The image and data storage paths in the frontend are tied to the managed web project lifecycle. If this repository is moved to another static host, replace the `/manus-storage/` asset paths with the equivalent public asset URLs for that host.
