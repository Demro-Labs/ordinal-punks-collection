/** Inscription Ledger: chemins locaux autonomes pour la publication GitHub Pages. */
export const COLLECTION_DATA_URL = `${import.meta.env.BASE_URL}assets/ordinal-punks/collection-data.json`;
export const SHEET_URLS = Array.from(
  { length: 100 },
  (_, index) => `${import.meta.env.BASE_URL}assets/ordinal-punks/sheets/sheet-${String(index).padStart(3, "0")}.webp`,
);
export const INSCRIPTION_BASE_URL = "https://fractal.unisat.io/inscription/";
