import { describe, expect, it } from "vitest";
import { deriveOrdiWallet } from "./ordi-wallet";
import { createLocalVaultSiteSession, isLocalVaultSiteSession } from "./local-vault-bridge";

const wallet = () => deriveOrdiWallet("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");

describe("Ordi Wallet local-vault site configuration", () => {
  it("binds the selected site, chain and address type to the matching public address", () => {
    const record = wallet();
    const session = createLocalVaultSiteSession({
      wallet: record,
      site: "punks",
      network: "FRACTAL_BITCOIN_MAINNET",
      activeAddressType: "taproot",
    });

    expect(session.site).toBe("punks");
    expect(session.network).toBe("FRACTAL_BITCOIN_MAINNET");
    expect(session.activeAddressType).toBe("taproot");
    expect(session.address).toBe(record.addresses.taproot.address);
    expect(session.publicKey).toBe(record.addresses.taproot.publicKey);
    expect(isLocalVaultSiteSession(session)).toBe(true);
  });

  it("contains public connection metadata only, never recovery or signing secrets", () => {
    const session = createLocalVaultSiteSession({
      wallet: wallet(),
      site: "pokedex",
      network: "BITCOIN_MAINNET",
      activeAddressType: "native-segwit",
    });
    const serialized = JSON.stringify(session);
    expect(serialized).not.toContain("privateKey");
    expect(serialized).not.toContain("mnemonic");
    expect(serialized).not.toContain("passphrase");
    expect(isLocalVaultSiteSession(session)).toBe(true);
  });

  it("rejects a session whose active address or public key does not match the selected key type", () => {
    const session = createLocalVaultSiteSession({
      wallet: wallet(),
      site: "pokedex",
      network: "BITCOIN_MAINNET",
      activeAddressType: "native-segwit",
    });
    expect(isLocalVaultSiteSession({ ...session, address: session.addresses.legacy.address })).toBe(false);
    expect(isLocalVaultSiteSession({ ...session, publicKey: session.addresses.taproot.publicKey })).toBe(false);
  });

  it("rejects sessions that accidentally include a private key", () => {
    const session = createLocalVaultSiteSession({
      wallet: wallet(),
      site: "punks",
      network: "BITCOIN_MAINNET",
      activeAddressType: "native-segwit",
    });
    expect(isLocalVaultSiteSession({ ...session, privateKey: wallet().addresses["native-segwit"].privateKey })).toBe(false);
    expect(isLocalVaultSiteSession({
      ...session,
      addresses: { ...session.addresses, "native-segwit": { ...session.addresses["native-segwit"], privateKey: "secret" } },
    })).toBe(false);
  });
});
