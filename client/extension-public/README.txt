ORDI WALLET — DESKTOP EXTENSION PREVIEW

INSTALL (CHROME / EDGE / BRAVE / CHROMIUM)
1. Unzip this archive.
2. Open the browser extensions page and enable Developer mode.
3. Choose Load unpacked and select this extracted folder.

FIREFOX
Load manifest.json temporarily from about:debugging#/runtime/this-firefox. Temporary add-ons are removed on restart; permanent use requires Mozilla signing.

SECURITY / SCOPE
- Unsigned developer preview; not store-published and not independently audited. Test only with a wallet that holds no valuable funds.
- The encrypted vault is stored in this extension's own browser origin. Website vaults are separate; no provider is injected and no private keys are shared with sites.
- Live balances and inscription locations use public indexer endpoints. The local vault supports reviewed native BTC/FB and single-inscription Ordinal PSBTs on Bitcoin and Fractal. Signing and irreversible broadcasting are separate explicit actions; inscriptions and fee inputs are rechecked before signing.
- Desktop only. Safari and mobile extension installation are not supported.
