import { describe, expect, it } from "vitest";
import { Buffer } from "buffer";
import { Verifier } from "@exodus/bip322-js";
import { ADDRESS_SPECS, deriveOrdiWallet } from "@/lib/ordi-wallet";
import { signLocalOwnershipMessage } from "@/lib/local-vault-ownership";

describe("local Ordi Wallet BIP-322 ownership proof", () => {
  it.each(ADDRESS_SPECS.map(spec => [spec.type, spec.type] as const))("signs and verifies a one-time message for %s", async (_label, addressType) => {
    const wallet = deriveOrdiWallet("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
    const message = "demro-labs.github.io requests a wallet ownership proof\nNonce: test-only";
    const account = wallet.addresses[addressType];
    const signature = await signLocalOwnershipMessage(account, message);
    const witness = typeof signature === "string" ? Buffer.from(signature.replace(/^smp/, ""), "base64") : Buffer.from(signature);
    expect(await Verifier.verifySignature(account.address, message, witness), addressType).toBe(true);
  });
});
