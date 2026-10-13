import { Buffer } from 'buffer';

// bitcoinjs-lib 6.x (pulled in by @exodus/bip322-js) evaluates Buffer at
// module initialization time. Cloudflare Workers do not expose Node's Buffer
// global by default, so install the browser-compatible implementation before
// importing any BIP-322 or bitcoinjs modules.
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer;
