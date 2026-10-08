# Security policy

## Scope

This repository publishes a public, read-only static collection site. It does not request passwords, wallet seed phrases, private keys, payment-card details, or other authentication secrets. The live market data API is a separate Cloudflare Worker; its UniSat credential must remain a Cloudflare secret binding and must never be committed or exposed in browser code.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/Demro-Labs/ordinal-punks-collection/security/advisories/new). Do not publish exploit details or include credentials in a public issue. Include the affected URL/component, impact, and reproducible steps that do not access or modify other users' data.

## Security baseline

The site enforces HTTPS on GitHub Pages, applies a restrictive HTML Content Security Policy, and uses a read-only Worker API. CI runs type-checking, a production dependency audit, and a production build. Third-party GitHub Actions are pinned to immutable commit SHAs; Dependabot checks packages and Actions weekly.

## Limitations

No site can be guaranteed “100% secure.” GitHub Pages controls the site's TLS termination and response headers; the repository cannot configure GitHub's TLS cipher/key-agreement policy. Cloudflare documents hybrid post-quantum key agreement for supported clients connecting to `*.workers.dev`; this protects the Worker connection only when both endpoints negotiate it. Post-quantum TLS does not prevent XSS, compromised dependencies, account takeover, or denial of service.
