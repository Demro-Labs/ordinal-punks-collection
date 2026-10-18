# Ordi Wallet browser extension preview

This repository can build an unpacked desktop WebExtension popup that reuses the site's encrypted local vault, live balance views, protocol-transfer routing, reviewed local BTC/FB transfers, and locally signed Ordinal transfers.

## Build

```bash
pnpm install
pnpm build:extension
```

The extension is built into `dist/extension/` and packaged as `client/public/downloads/ordi-wallet-extension.zip`. The main site exposes the installation guide at `/extension-install.html` and the archive in its downloads folder.

## Desktop installation

- **Chrome / Edge / Brave / Chromium:** unzip the archive, open the browser's extensions page, enable Developer mode, then choose **Load unpacked** and select the extracted folder.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…**, and select the manifest. Firefox removes temporary add-ons at restart; permanent distribution needs Mozilla signing.

## Important limitations

- This is an unsigned preview, not a Chrome Web Store, Edge Add-ons, or Mozilla Add-ons release, and it has not had an independent security audit.
- Safari and mobile-browser installation are not supported by this build.
- Extension storage is isolated from each website's origin. The extension does not inject a provider or silently share private keys with either website. Import the same recovery phrase separately into a site's local vault if using that website's existing local-vault integration.
- Public balances/activity and live inscription locations come from Mempool and the shared indexer Worker. Native BTC/FB and single-inscription Ordinal transfers can be reviewed and signed by the local vault for Bitcoin and Fractal; the Ordinal path rechecks the complete indexed inscription set and exact asset-free fee inputs, and requires separate explicit signing and broadcast actions. Runes, BRC-20, BRC20-Prog and Alkanes keep their explicitly identified UniSat routes; they are not treated as generic BTC signing.
- Never package, publish, or use this preview for valuable funds until the source and security model have been independently reviewed.
