export function shouldShowDustRelayGuidance(message: string): boolean {
  return /dust|0-fee/i.test(message) && !/\bnon-dust\b/i.test(message);
}
