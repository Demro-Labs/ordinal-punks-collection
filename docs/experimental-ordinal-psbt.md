# Mobile UniSat transfers and file inscriptions

## Active mobile flow

The app uses UniSat's native wallet methods. It does not construct or sign a custom PSBT in the active transfer or file-payment UI, and it does not require `signPsbt`, `pushPsbt`, or `pushTx` for those actions. If a native method is absent, the app fails closed rather than falling back to a custom transaction builder.

### Temporary Fractal mobile transfer pause

UniSat Mobile returned `Cannot read property 'toAddress' of undefined` from its native `sendInscription` method during a Fractal mobile transfer. The app temporarily disables only Fractal inscription transfers on mobile, before opening another wallet request. The guard is limited to mobile user agents on `FRACTAL_BITCOIN_MAINNET`; it does not alter desktop behavior, Bitcoin mobile transfer behavior, or file-inscription code. No custom PSBT fallback is enabled. Re-enable the Fractal mobile transfer only after UniSat resolves the native method issue and a real-device smoke test passes.

### Ordinal transfers

Outside the temporary pause above, the client validates the destination with the matching network's Mempool endpoint, obtains a live fee estimate, and calls UniSat `sendInscription`. UniSat is expected to construct the transaction, present its final review, obtain explicit approval, sign, and broadcast. The app checks the returned TXID and tracks it in the selected network's Mempool. An uncertain result blocks repeat attempts until the user checks wallet activity and Mempool.

### File inscriptions

The existing Cloudflare Worker proxies UniSat Inscribe API V5; its server-side `UNISAT_API_KEY` is not exposed to the browser. Before creating an order, the client validates the connected wallet address with Mempool. Before paying an order, it checks that the wallet is still on the receipt's network, validates UniSat's payment address with Mempool, fetches a live fee rate, and calls UniSat `sendBitcoin`. The user's reported mobile failure in this flow is under diagnosis and may occur during order creation, wallet payment approval, or post-payment tracking. This transfer pause does not change the file-inscription payment route. Do not retry a payment after an ambiguous wallet response until UniSat activity and Mempool have been checked.

## What Mempool does and does not approve

Mempool is used for network-specific address validation, live fee estimates, and post-broadcast transaction visibility/confirmation tracking. The public Mempool API does not provide this client with a pre-signature approval of a UniSat-native transaction or protocol-level certification. The wallet's review and explicit approval remain authoritative for signing and broadcasting.

The older custom PSBT modules and their offline tests remain in the repository for isolated research/regression coverage; they are not connected to the active mobile UI. The low-fee UTXO Worker endpoint is likewise not part of these native wallet calls.

## Verification and manual check

The local pause branch has passed 49 Vitest tests (excluding the separate integration test that requires a local UniSat secret), TypeScript checking, production build, and `git diff --check`. No live wallet was asked to sign, no real UTXO was unlocked, and no transaction was broadcast during validation. A real-device smoke test inside UniSat Mobile remains necessary before re-enabling Fractal mobile transfers.

## References

- [UniSat Wallet API](https://docs.unisat.io/developer-support/open-api-documentation/unisat-wallet)
- [UniSat connect with UniSat Mobile](https://docs.unisat.io/developer-support/open-api-documentation/unisat-wallet/connect-with-unisat-mobile-wallet)
- [UniSat Inscribe API V5](https://github.com/unisat-wallet/unisat-dev-docs/blob/master/open-api/auto-generated/docs/inscribe-v5.md)
- [Mempool REST API](https://mempool.space/docs/api/rest)
- [Mempool FAQ](https://mempool.space/docs/faq)
