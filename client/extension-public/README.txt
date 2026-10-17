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
- Live public balances use Mempool endpoints. Local PSBT signing is limited to the Native SegWit vault key and requires an explicit review. Broadcasting is a separate irreversible action.
- Desktop only. Safari and mobile extension installation are not supported.
