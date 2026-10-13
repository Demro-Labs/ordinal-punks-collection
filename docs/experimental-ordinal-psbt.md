# Mobile UniSat transfers and file inscriptions

## Active mobile flow

The mobile app now uses UniSat's native wallet methods. The website does not construct or sign a custom PSBT in the active transfer or file-payment UI, and it does not require `signPsbt`, `pushPsbt`, or `pushTx` for these actions. If the native method is not exposed by the connected UniSat context, the app fails closed instead of falling back to a custom transaction builder.

### Ordinal transfers

The client validates the destination with the matching network's Mempool endpoint, obtains the live fee estimate, and calls UniSat `sendInscription`. UniSat builds the transaction, presents its own final review, requests the user's approval, signs, and broadcasts. The app checks the returned TXID and then tracks it in the selected network's Mempool. An uncertain result blocks repeat attempts until the user checks wallet activity and Mempool.

### File inscriptions

The existing Cloudflare Worker proxies UniSat Inscribe API V5; its server-side `UNISAT_API_KEY` is not exposed to the browser. Before creating an order, the client validates the connected wallet address with Mempool. Before paying an order, it checks that the wallet is still on the receipt's network, validates UniSat's payment address with Mempool, fetches a live fee rate, and calls UniSat `sendBitcoin`. The user must approve the amount and final fee in UniSat. Once UniSat returns a TXID, the app tracks the payment in Mempool and polls the UniSat V5 order status.

## What Mempool does and does not approve

Mempool is used for network-specific address validation, live fee estimates, and post-broadcast transaction visibility/confirmation tracking. The public Mempool API does not provide this client with a pre-signature approval of a UniSat-native transaction or protocol-level certification. The wallet's review and explicit approval remain authoritative for signing and broadcasting.

The older custom PSBT modules and their offline tests remain in the repository for isolated research/regression coverage; they are not connected to the active mobile UI. The low-fee UTXO Worker endpoint is likewise not part of these native wallet calls.

## Verification and manual check

The native-wallet helper tests verify the exact UniSat method calls, request parameters, returned TXID handling, and fail-closed behavior. TypeScript checks and production builds pass; the full offline suites pass (Ordinal Punks excludes only the separate integration test that requires the local UniSat secret). No live wallet was asked to sign, no real UTXO was unlocked, and no transaction was broadcast during these checks. A real-device smoke test inside the target UniSat Mobile version remains necessary before production rollout.

## References

- [UniSat Wallet API](https://docs.unisat.io/developer-support/open-api-documentation/unisat-wallet)
- [UniSat connect with UniSat Mobile](https://docs.unisat.io/developer-support/open-api-documentation/unisat-wallet/connect-with-unisat-mobile-wallet)
- [UniSat Inscribe API V5](https://github.com/unisat-wallet/unisat-dev-docs/blob/master/open-api/auto-generated/docs/inscribe-v5.md)
- [Mempool REST API](https://mempool.space/docs/api/rest)
- [Mempool FAQ](https://mempool.space/docs/faq)
