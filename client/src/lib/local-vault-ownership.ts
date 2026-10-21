import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { Signer } from "@exodus/bip322-js";
import type { OrdiAddress } from "@/lib/ordi-wallet";

bitcoin.initEccLib(ecc);

function taprootMessageSignature(account: OrdiAddress, message: string): string {
  const privateKey = Buffer.from(account.privateKey, "hex");
  const publicKey = Buffer.from(account.publicKey, "hex");
  if (privateKey.length !== 32 || publicKey.length !== 33 || !ecc.isPrivate(privateKey)
    || !Buffer.from(ecc.pointFromScalar(privateKey, true) ?? []).equals(publicKey)) {
    throw new Error("The local Taproot key does not match the selected public account.");
  }
  const script = Buffer.from(bitcoin.address.toOutputScript(account.address, bitcoin.networks.bitcoin));
  const internalKey = Buffer.from(bitcoin.toXOnly(publicKey));
  const messageTagHash = bitcoin.crypto.sha256(Buffer.from("BIP0322-signed-message", "utf8"));
  const taggedMessageHash = bitcoin.crypto.sha256(Buffer.concat([messageTagHash, messageTagHash, Buffer.from(message, "utf8")]));
  const toSpend = new bitcoin.Transaction();
  toSpend.version = 0;
  toSpend.locktime = 0;
  toSpend.addInput(Buffer.alloc(32), 0xffffffff, 0, Buffer.concat([Buffer.from([0x00, 0x20]), taggedMessageHash]));
  toSpend.addOutput(script, BigInt(0));

  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
  psbt.setVersion(0);
  psbt.setLocktime(0);
  psbt.addInput({
    hash: toSpend.getId(), index: 0, sequence: 0,
    witnessUtxo: { script, value: BigInt(0) }, tapInternalKey: internalKey,
  });
  psbt.addOutput({ script: Buffer.from([bitcoin.opcodes.OP_RETURN]), value: BigInt(0) });

  const parityAdjustedKey = publicKey[0] === 3 ? Buffer.from(ecc.privateNegate(privateKey)) : privateKey;
  const tweak = bitcoin.crypto.taggedHash("TapTweak", internalKey);
  const tweakedPrivateKey = ecc.privateAdd(parityAdjustedKey, tweak);
  if (!tweakedPrivateKey) throw new Error("Unable to derive the local Taproot message-signing key.");
  const tweakedPublicKey = ecc.pointFromScalar(tweakedPrivateKey, true);
  if (!tweakedPublicKey) throw new Error("Unable to derive the local Taproot message-signing public key.");
  psbt.signInput(0, {
    publicKey: Buffer.from(tweakedPublicKey),
    sign: (hash: Uint8Array) => Buffer.from(ecc.sign(Buffer.from(hash), Buffer.from(tweakedPrivateKey))),
    signSchnorr: (hash: Uint8Array) => Buffer.from(ecc.signSchnorr(Buffer.from(hash), Buffer.from(tweakedPrivateKey))),
  });
  psbt.finalizeAllInputs();
  const witness = psbt.data.inputs[0]?.finalScriptWitness;
  if (!witness?.length) throw new Error("The local Taproot ownership proof did not produce a witness.");
  return Buffer.from(witness).toString("base64");
}

export async function signLocalOwnershipMessage(account: OrdiAddress, message: string): Promise<string> {
  if (!account?.address || !account?.privateKey || !account?.publicKey || !message) {
    throw new Error("The local wallet account or ownership challenge is unavailable.");
  }
  if (account.type === "taproot") return taprootMessageSignature(account, message);
  const signature = await Signer.signAsync(Buffer.from(account.privateKey, "hex"), account.address, message, bitcoin.networks.bitcoin);
  return typeof signature === "string" ? signature : Buffer.from(signature).toString("base64");
}
