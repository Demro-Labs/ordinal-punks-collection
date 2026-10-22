# Ordinal Punks Collection

A production-ready visual archive for the **10,000 Ordinal Punks inscribed on Fractal Bitcoin**. The site combines a local collection catalogue with live market data, inscription metadata, UniSat wallet operations, transfer tooling, inscription preparation, and UniScan links.

## Production site

- **Live application:** https://ordi-labs.github.io/punks/
- **Repository:** https://github.com/ordi-labs/punks
- **Shared live Worker:** https://fractal-ordinal-live.servostar23.workers.dev

## Product overview

The application is intentionally split into two data layers:

1. **Local catalogue layer** — collection metadata, image assets, traits, inscription identifiers, and static presentation remain available from the repository even when an external API is unavailable.
2. **Live service layer** — market values, ownership details, wallet balances, UTXOs, inscription orders, and transaction information are fetched only when the relevant feature is used.

This approach keeps the catalogue fast and resilient while clearly separating cached collection information from network-dependent data.

## Main features

### Collection catalogue

- Browse the complete 10,000-item collection.
- View optimized local images and collection metadata.
- Search and inspect inscription ID, number, name, description, file, token ID, and traits.
- Open an inscription detail view with live owner, creator, and listing information when available.
- Open the relevant UniSat or UniScan page in a separate tab.
- Continue viewing local collection data when live services are unavailable.

### Live market data

The market panel reads live collection statistics through the shared Cloudflare Worker. Depending on API availability, the interface can display floor price, volume, market capitalization, listing information, and related marketplace values. Live values are treated as external data and are not used as a substitute for local collection metadata.

### UniSat wallet session

The wallet panel is designed around explicit user actions:

- **Connect UniSat** requests access to the selected UniSat account.
- **Disconnect UniSat** clears the active application session and attempts the provider disconnect method when the installed UniSat version exposes it.
- **Clear session** stops an active inscription load, clears the address and network from the interface, resets live dashboard values, and removes loaded wallet inscriptions and transfer state.
- **Load my inscriptions** starts a manual fetch of the inscriptions owned by the connected account.
- **Stop loading** cancels the active loading run and prevents late provider responses from repopulating the gallery.
- Inscription loading is manual; connecting a wallet does not silently fetch the entire collection.

The dashboard refreshes live wallet data while a supported wallet session is active. It can show:

- active network;
- confirmed and unconfirmed balance;
- total and available balance;
- unavailable balance;
- public key when provided by UniSat;
- UTXO count and aggregate UTXO value;
- number of loaded inscriptions and the last refresh time;
- connected address and a direct UniScan address link.

The dashboard refresh interval is approximately 15 seconds. Values may be unavailable when a provider method is not supported or the wallet is locked.

### Inscription gallery, search, and display modes

The **My inscriptions** panel presents the inscriptions returned by UniSat, ten items per page.

- **Mosaic** — large square previews for visual browsing.
- **Compact** — denser multi-column grid for scanning more items at once.
- **List** — one-column detailed layout with wide previews.
- Search by inscription ID, inscription number, or location.
- Search results update the current page and show the number of matches.
- **Open result in UniScan** opens the first matching inscription on the correct Bitcoin or Fractal UniScan route.
- Each card includes a live detail link and a transfer action.
- The pagination uses separate gray tones for Previous, the page/match status, and Next.

### Inscription selection and transfer

The transfer workflow is designed to keep the user in control:

1. Select an inscription from the wallet gallery or an inscription detail panel.
2. Enter and validate the recipient address.
3. Review the live pre-confirmation summary.
4. Review the inscription, recipient, network, fee and UTXO information.
5. Approve the transaction in UniSat.
6. Track the returned transaction through the relevant mempool endpoint.

The UI only offers inscriptions that are recognized as transferable. Inscription outputs and detected protocol assets are excluded from fee-UTXO selection to reduce the risk of accidentally spending or damaging an asset. The user must still verify the final UniSat confirmation screen before approving anything.

The secure fee-UTXO route is:

```text
GET https://fractal-ordinal-live.servostar23.workers.dev/api/spendable-utxos
```

The Worker validates the request, address, output script, amount, inscription status, protocol-asset status, and other safety conditions. It does not and cannot bypass Fractal Bitcoin dust policy.

### Upload and inscription preparation

The inscription panel supports:

- selecting or dropping a file into the upload area;
- reviewing file name, MIME type, size, and content information;
- creating an inscription order through the Worker;
- showing a live pre-confirmation receipt;
- opening the required approval flow in UniSat;
- tracking the order state and transaction result.

The site never signs or broadcasts an inscription payment on behalf of the user. Payment and final approval remain inside UniSat.

### Ownership proof (BIP-322)

On mobile UniSat, a fresh BIP-322 signature proves control of the selected address before an ordinal transfer, FB send, or file-inscription payment. The new classic BRC-20 and BRC20-Prog transfer flows require the same proof on desktop and mobile before creating an inscription order/payment, then ask UniSat separately to approve each Bitcoin transaction. For Inscribe on mobile, the order is **review receipt → confirm payment → sign the ownership proof → separately open UniSat transaction approval**. The proof never creates a login session or authorizes a payment; other existing desktop flows remain unchanged.

## Architecture

```text
Browser / React UI
        |
        | local metadata and images
        v
client/public/assets/
        |
        | live requests
        v
Cloudflare Worker
https://fractal-ordinal-live.servostar23.workers.dev
        |
        +--> UniSat APIs
        +--> market data providers
        +--> mempool / transaction endpoints
```

### Frontend

- React 19 with TypeScript.
- Vite for development and production builds.
- Tailwind CSS 4 for layout and responsive styling.
- `lucide-react` for interface icons.
- UniSat provider integration is kept in the wallet components.
- Local catalogue and image manifests are loaded from `client/public/assets/`.

### Backend and Worker integration

The application server is bundled from `server/index.ts`. Live and protected operations are routed through the Cloudflare Worker rather than exposing provider secrets in the browser.

Important Worker routes include:

- `/api/market` — collection market statistics;
- `/api/live-inscription` — live owner, creator, and listing details;
- `/api/spendable-utxos` — admissible fee UTXOs for transfers;
- `/api/inscribe/order` — inscription order creation and status;
- `/api/auth/ownership/challenge` and `/api/auth/ownership/verify` — short-lived ownership proofs, never transaction authorization;
- transaction and mempool-related routes used by the receipt and tracking flows.

### BRC protocol paths

- **Classic BRC-20 (4–5 character tickers)** uses the classic UniSat indexer and the existing inscription-transfer flow.
- **BRC20-Prog / BRC2.0 (6-character tickers)** is Bitcoin-mainnet-only in this app; its balance/module routes and UniSat module flow are disabled on Fractal Bitcoin. Classic BRC-20 remains available on both Bitcoin and Fractal.
- **Alkanes and Alkanes collections** are Bitcoin-mainnet-only and are neither queried nor shown on Fractal Bitcoin.
- **BRC2.0 UniSat flow** prepares the module inscription and activation transaction on Bitcoin mainnet with separate user approvals. The optional `/api/brc20-prog/module/status` route only probes `eth_blockNumber`, which does not verify module identity. Ordi Wallet Local Vault signing remains blocked for BRC2.0 and Alkanes until dedicated local builders and independent protocol-output validation are implemented.

The shared Worker also exposes `/api/brc20/balances`, `/api/brc20-prog/balances` (Bitcoin et Fractal, selon le réseau demandé), and `/api/brc20-prog/module/status`. Keep the optional `BRC20_PROG_RPC_URL`, `BRC20_PROG_FRACTAL_RPC_URL`, and, if needed, `BRC20_PROG_RPC_USER` / `BRC20_PROG_RPC_PASSWORD` as Cloudflare Worker secrets; never commit or expose them in browser code. See `workers/PRODUCTION-RUNBOOK.md` before configuring an endpoint.

The Worker keeps the UniSat API key in the server-side secret `UNISAT_API_KEY`. The key must never be placed in frontend source, static assets, or a public build artifact.

## Data and assets

The repository stores the local catalogue under:

```text
client/public/assets/
```

This directory contains collection manifests, metadata, optimized image sheets or image files, and visual assets. Local data is the fallback source for catalogue browsing; live APIs are used for information that changes on-chain or in the marketplace.

External live responses can be partial, delayed, rate-limited, or temporarily unavailable. Components should preserve the local catalogue and display an explicit unavailable state instead of presenting missing live values as authoritative.

## Local development

Requirements:

- Node.js compatible with the repository toolchain;
- pnpm 11;
- a browser with the UniSat Wallet extension for wallet testing.

Install dependencies and start the Vite development server:

```bash
pnpm install
pnpm run dev
```

Run the TypeScript check:

```bash
pnpm run check
```

Create the production frontend and server bundle:

```bash
pnpm run build
```

Run the compiled server:

```bash
pnpm run start
```

Useful additional command:

```bash
pnpm run preview
```

## Deployment

The site is deployed automatically to GitHub Pages from `main` by the repository workflow in `.github/workflows/`.

The footer's **Version GitHub déployée** links to the exact commit used for the Pages build and shows its commit date. The Pages workflow injects this metadata at build time.

The production base path is:

```text
/ordinal-punks-collection/
```

Vite uses that base path so local assets and client-side links continue to work under the GitHub Pages subdirectory.

Recommended release validation:

```bash
pnpm run check
pnpm run build
git diff --check
```

Pull requests are expected to pass the repository security, dependency, and CodeQL checks before merge.

Dependabot version-update and security-update pull requests are disabled by repository policy. GitHub vulnerability alerts remain enabled; manually maintained security and build checks continue to run.

## Security and user-control principles

- No wallet signature is requested merely to connect or inspect local metadata.
- Every transfer and inscription payment requires explicit approval in UniSat.
- The frontend does not receive the Worker’s UniSat API secret.
- Clear session removes wallet data from the application state; it does not revoke browser permissions granted inside UniSat when the provider has no disconnect API.
- Transfer preparation excludes detected inscription and protocol-asset UTXOs from fee selection.
- The application does not circumvent dust rules, provider policies, network consensus, or UniSat approval screens.
- Always verify the recipient address, network, output, fee, and final UniSat review screen before approving a transaction.

## License

This repository is released under the MIT license specified in `package.json`.
