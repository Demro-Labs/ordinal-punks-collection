export type InscribeAccessReceipt = { walletAddress: string; chain: string };

const ELIGIBLE_NETWORKS = new Set(["BITCOIN_MAINNET", "FRACTAL_BITCOIN_MAINNET"]);

export function canAccessInscribeReceiptForWallet(
  receipt: InscribeAccessReceipt,
  walletAddress: string,
  network: string | null | undefined,
): boolean {
  return Boolean(
    walletAddress.trim() &&
    network &&
    ELIGIBLE_NETWORKS.has(network) &&
    receipt.chain === network &&
    receipt.walletAddress.toLowerCase() === walletAddress.trim().toLowerCase(),
  );
}
