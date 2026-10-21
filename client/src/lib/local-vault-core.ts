export type LocalVaultReviewInput = {
  txid: string;
  vout: number;
  valueSats: number;
  scriptHex: string;
};

export type LocalVaultReviewOutput = {
  address: string;
  valueSats: number;
  scriptHex: string;
};

export type LocalVaultReviewSnapshot = {
  psbtHex: string;
  network: string;
  addressType: string;
  sourceAddress: string;
  inputCount: number;
  outputCount: number;
  inputSats: number;
  outputSats: number;
  feeSats: number;
  feeRateSatVb: number;
  inputs: readonly LocalVaultReviewInput[];
  outputs: readonly LocalVaultReviewOutput[];
};

function assertSafeSats(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Local Vault: ${label} invalide.`);
}

/** Pure integrity checks: no network access and no private-key handling. */
export function assertLocalVaultReviewIntegrity(review: LocalVaultReviewSnapshot): void {
  if (review.network !== "BITCOIN_MAINNET" && review.network !== "FRACTAL_BITCOIN_MAINNET") {
    throw new Error("Local Vault: réseau non pris en charge.");
  }
  if (!/^(?:[a-f0-9]{2})+$/i.test(review.psbtHex) || review.psbtHex.length > 2_000_000) {
    throw new Error("Local Vault: empreinte PSBT invalide.");
  }
  if (!["legacy", "nested-segwit", "native-segwit", "taproot"].includes(review.addressType) || !review.sourceAddress) {
    throw new Error("Local Vault: compte source invalide.");
  }
  if (!Array.isArray(review.inputs) || !Array.isArray(review.outputs) ||
      review.inputCount !== review.inputs.length || review.outputCount !== review.outputs.length ||
      review.inputCount < 1 || review.inputCount > 20 || review.outputCount < 1 || review.outputCount > 20) {
    throw new Error("Local Vault: nombre d’entrées ou de sorties incohérent.");
  }

  const seen = new Set<string>();
  let inputTotal = 0;
  for (const input of review.inputs) {
    if (!/^[a-f0-9]{64}$/i.test(input.txid) || !Number.isSafeInteger(input.vout) || input.vout < 0 ||
        !/^(?:[a-f0-9]{2})+$/i.test(input.scriptHex)) throw new Error("Local Vault: entrée examinée invalide.");
    assertSafeSats(input.valueSats, "valeur d’entrée");
    const outpoint = `${input.txid.toLowerCase()}:${input.vout}`;
    if (seen.has(outpoint)) throw new Error("Local Vault: entrée UTXO dupliquée.");
    seen.add(outpoint);
    inputTotal += input.valueSats;
    if (!Number.isSafeInteger(inputTotal)) throw new Error("Local Vault: total des entrées hors limites.");
  }

  let outputTotal = 0;
  for (const output of review.outputs) {
    if (typeof output.address !== "string" || output.address.length === 0 ||
        !/^(?:[a-f0-9]{2})+$/i.test(output.scriptHex)) throw new Error("Local Vault: sortie examinée invalide.");
    assertSafeSats(output.valueSats, "valeur de sortie");
    outputTotal += output.valueSats;
    if (!Number.isSafeInteger(outputTotal)) throw new Error("Local Vault: total des sorties hors limites.");
  }

  assertSafeSats(review.inputSats, "total des entrées");
  assertSafeSats(review.outputSats, "total des sorties");
  assertSafeSats(review.feeSats, "frais");
  if (!Number.isFinite(review.feeRateSatVb) || review.feeRateSatVb <= 0 || review.feeRateSatVb > 1_000 ||
      inputTotal !== review.inputSats || outputTotal !== review.outputSats ||
      review.inputSats - review.outputSats !== review.feeSats) {
    throw new Error("Local Vault: les montants ou frais ne correspondent pas à l’examen.");
  }
}

export function assertLocalVaultReviewUnchanged(current: LocalVaultReviewSnapshot, approved: LocalVaultReviewSnapshot): void {
  assertLocalVaultReviewIntegrity(current);
  assertLocalVaultReviewIntegrity(approved);
  if (
    current.psbtHex.toLowerCase() !== approved.psbtHex.toLowerCase() ||
    current.network !== approved.network || current.addressType !== approved.addressType ||
    current.sourceAddress !== approved.sourceAddress || current.inputCount !== approved.inputCount ||
    current.outputCount !== approved.outputCount || current.inputSats !== approved.inputSats ||
    current.outputSats !== approved.outputSats || current.feeSats !== approved.feeSats ||
    current.feeRateSatVb !== approved.feeRateSatVb ||
    JSON.stringify(current.inputs) !== JSON.stringify(approved.inputs) ||
    JSON.stringify(current.outputs) !== JSON.stringify(approved.outputs)
  ) throw new Error("Le PSBT, les UTXO, le réseau ou les frais ont changé depuis l’examen; aucune signature ni diffusion.");
}
