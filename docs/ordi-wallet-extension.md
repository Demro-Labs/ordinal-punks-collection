# Ordi Wallet browser extension preview

Version 0.6.0 builds an unpacked desktop WebExtension popup using the local encrypted vault. It displays live BTC/FB balances for Legacy, Nested SegWit, Native SegWit and Taproot accounts, recent sent/received chain activity, indexed Ordinals/inscriptions and protocol balances, including Bitcoin Alkane collections.

## Build

```bash
pnpm install
pnpm build:extension
```

The extension is built into `dist/extension/` and packaged as `client/public/downloads/ordi-wallet-extension.zip`. The site exposes the installation guide at `/extension-install.html` and the archive in its downloads folder.

## Desktop installation

For Chrome, Edge, Brave and other Chromium browsers, unzip the archive, open the browser's extensions page, enable Developer mode, select **Load unpacked**, and choose the extracted folder. For Firefox, use `about:debugging#/runtime/this-firefox` and **Load Temporary Add-on…**; Firefox removes temporary add-ons at restart, while permanent distribution requires Mozilla signing.

## Scope and security

This is an unsigned preview, not a browser-store release, and it has not had an independent security audit. Safari and mobile-browser extension installation are not supported; the website wallet layout remains responsive on mobile and desktop.

Extension storage is isolated from each website's origin. The extension does not inject a provider or silently share private keys with either site. Import the same recovery phrase separately into a site's local vault if using its existing wallet connection.

Live portfolio information is read-only and comes from Mempool and the shared indexer Worker. Local signing is enabled only for ordinary native BTC/FB transfers and single-Ordinal transfers after their existing ownership, UTXO, output and fee checks. BRC-20, BRC20-Prog, Runes and Alkanes are displayed/indexed but are not signed by this Local Vault portfolio panel; their existing separate routes are not local protocol PSBT signing. The ordinary BTC/FB signer intentionally rejects protocol outputs.

Do not use this unsigned preview with valuable funds until the source and security model have been independently reviewed.
