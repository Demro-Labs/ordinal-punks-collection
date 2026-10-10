# Experimental custom Ordinal transfer (PSBT)

## Status

This path is **disabled by default** in `UniSatWalletConnect.tsx` (`CUSTOM_PSBT_TRANSFER_ENABLED = false`). The existing UniSat `sendInscription` path remains active. Do not flip the flag or enable this path in production until every manual check below is complete. No wallet signing or live transaction broadcast was performed while developing this code.

The existing Cloudflare Worker `fractal-ordinal-live` now has an additive `/api/spendable-utxos` route for Bitcoin and Fractal mainnet. Its UniSat API credential remains in the `UNISAT_API_KEY` secret binding and is never sent to the browser. The Worker configuration and secret binding were verified after the content-only update. The safe-UTXO route was not fully validated from this sandbox on both networks; one later direct probe was blocked by Cloudflare browser-signature protection.

## Transaction shape and guards

- The selected inscription outpoint is always input 0. Its sat offset is parsed from UniSat’s `txid:vout:offset` location and checked against the source output value.
- The inscription is always routed to output 0. Its value is at least 1,200 sats, or `offset + 1` when the marked sat lies farther into the source output.
- Fee candidates must appear in both the active wallet’s `getBitcoinUtxos` result and the Cloudflare proxy of UniSat OpenAPI `/v1/indexer/address/{address}/available-utxo-data`. The proxy supports `open-api.unisat.io` (Bitcoin mainnet) and `open-api-fractal.unisat.io` (Fractal mainnet). The client cross-checks each candidate’s outpoint, value and script against Mempool’s raw previous transaction and the active UniSat key.
- The Worker and client reject malformed outputs, outputs below 600 sats, unconfirmed or low-fee outputs, RBF-marked outputs, and outputs reporting any inscriptions. The official UniSat `available-utxo-data` contract excludes inscriptions, Runes, Alkanes and other protocol assets by default, as well as dust below 600 sats.
- **Important unresolved limitation:** UniSat documents that an asset-bearing UTXO explicitly unlocked in its UTXO-management tool can subsequently be returned as “available.” The response contract does not give this prototype a reliable flag to distinguish such an unlocked asset-bearing outpoint from ordinary BTC. Therefore, the code cannot guarantee that a manually unlocked Runes/Alkanes (or other protocol-asset) UTXO will never be selected. Do not enable this path unless this case is independently resolved and verified; the feature flag remains off.
- Multiple inscriptions sharing the selected outpoint cause a hard failure. Any inscription outpoint in the loaded wallet inventory is excluded from fee inputs.
- Change is returned only when it can be at least 1,200 sats. Otherwise the constructor accepts only a small, bounded no-change fee; if it cannot meet that bound, it refuses to create a PSBT.
- Source fee inputs support single-key Legacy P2PKH, Nested SegWit P2SH-P2WPKH, Native SegWit P2WPKH and Taproot P2TR key-path. Legacy inputs include the full previous transaction; nested inputs include the redeem script; Taproot inputs include the internal key. Other source scripts (including P2WSH and Taproot script-path) fail closed.
- Recipient scripts are derived locally with BitcoinJS for Bitcoin mainnet address encodings and must exactly match the chain-specific Mempool validation response. Recipient outputs support Legacy P2PKH, P2SH, Native SegWit P2WPKH/P2WSH and Taproot P2TR; non-standard scripts are rejected.
- UniSat is asked to sign without auto-finalizing. Before broadcast, the client checks ECDSA/Schnorr signatures cryptographically, finalizes locally, then verifies input order, version, locktime, sequences, exact output scripts/values, dust floor, fee accounting and actual virtual-size fee rate. The wallet account, public key and chain are rechecked immediately before signing, after signing and just before broadcast.
- On success, raw transaction hex is sent to the selected Mempool endpoint for the active Bitcoin or Fractal mainnet. No transaction is broadcast during offline testing.

## Validation performed

Offline tests cover real test-only signatures and finalization for all four supported input styles; Legacy, Nested SegWit, Native SegWit, P2WSH and Taproot recipient scripts; inscription offsets; dust-safe output/change; multiple inscriptions in one outpoint; inscription UTXO exclusion; invalid script ownership; and rejection of a modified ECDSA signature. Run with:

```sh
pnpm exec vitest run client/src/lib/ordinal-transfer-psbt.test.ts
pnpm check
pnpm build
```

The tests do **not** substitute for signing and inspection in UniSat, nor do they establish relay-policy behavior on both live networks. The Cloudflare Worker content update returned success and its source/settings were read back; the `UNISAT_API_KEY` binding remained present and its value was not read or exposed. A complete Bitcoin-mainnet upstream probe could not be confirmed from the sandbox.

## Manual review required before activation

1. Resolve the documented UniSat “explicitly unlocked asset UTXO” exception. Either add a trustworthy, tested asset-status check or prove by manual UTXO review that no such output can be selected. Until then, keep the feature flag `false`.
2. In UniSat on non-sensitive test UTXOs, inspect and sign—but do not broadcast—PSBTs for P2PKH, P2SH-P2WPKH, P2WPKH and P2TR key-path on **both** Fractal and Bitcoin mainnet. Confirm `signPsbt(autoFinalized: false)` and Taproot `useTweakedSigner` behavior for the target UniSat version/platform.
3. Verify the Cloudflare proxy returns the expected filtered UTXOs on both networks from an allowed site origin. Do not retry from a client that Cloudflare has blocked; ask the site owner to validate from the intended browser/session.
4. Review every PSBT outpoint, input script/value, inscription offset, output destination/value, change address, signature, fee/vsize and transaction fields before any real wallet confirmation.
5. Recheck Mempool minimum-relay/dust rules and actual fee-rate acceptance on both networks immediately before activation.
6. Only after the above independent reviews and a separate explicit approval should anyone consider changing `CUSTOM_PSBT_TRANSFER_ENABLED`.

## References

- [UniSat OpenAPI BTC balance and UTXO rules](https://github.com/unisat-wallet/unisat-dev-docs/blob/master/open-api/btc-balance-utxo.md)
- [UniSat Bitcoin mainnet Get BTC UTXO](https://docs.unisat.io/developer-support/open-api-documentation/api-for-bitcoin/general/addresses/get-btc-utxo)
- [UniSat Fractal mainnet Get BTC UTXO](https://docs.unisat.io/developer-support/open-api-documentation/api-for-fractal-bitcoin/general/addresses/get-btc-utxo)
- [UniSat Wallet manage-assets API](https://github.com/unisat-wallet/unisat-dev-docs/blob/master/wallet-api/api-docs/manage-assets.md)
- [Mempool API documentation](https://mempool.space/docs/api/rest)
