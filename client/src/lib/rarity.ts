export type Trait = { trait_type: string; value: string };
export type RarityTier = "Common" | "Uncommon" | "Rare" | "Epic" | "Legendary";
export type RarityRecord = { id: string; attributes: Trait[] };
export type TraitRarity = { count: number; total: number; percentage: number; tier: RarityTier };
export type TokenRarity = { score: number; rank: number; total: number; percentile: number; tier: RarityTier };
export type RarityIndex = {
  trait: (record: RarityRecord, attribute: Trait) => TraitRarity;
  token: (record: RarityRecord) => TokenRarity;
};

export const RARITY_META: Record<RarityTier, { icon: string; label: string; text: string; border: string; bg: string }> = {
  Common: { icon: "○", label: "Common", text: "text-[#9ea7b3]", border: "border-[#4a5562]", bg: "bg-[#4a5562]/15" },
  Uncommon: { icon: "◇", label: "Uncommon", text: "text-[#70c7a0]", border: "border-[#70c7a0]/60", bg: "bg-[#70c7a0]/10" },
  Rare: { icon: "◆", label: "Rare", text: "text-[#6fa9e8]", border: "border-[#6fa9e8]/60", bg: "bg-[#6fa9e8]/10" },
  Epic: { icon: "✦", label: "Epic", text: "text-[#c48af0]", border: "border-[#c48af0]/60", bg: "bg-[#c48af0]/10" },
  Legendary: { icon: "✧", label: "Legendary", text: "text-[#f2bd63]", border: "border-[#f2bd63]/70", bg: "bg-[#f2bd63]/12" },
};

function tierFromPrevalence(percentage: number): RarityTier {
  if (percentage <= 1) return "Legendary";
  if (percentage <= 5) return "Epic";
  if (percentage <= 15) return "Rare";
  if (percentage <= 35) return "Uncommon";
  return "Common";
}

function tierFromRank(rank: number, total: number): RarityTier {
  const percentile = rank / Math.max(total, 1);
  if (percentile <= 0.01) return "Legendary";
  if (percentile <= 0.05) return "Epic";
  if (percentile <= 0.2) return "Rare";
  if (percentile <= 0.5) return "Uncommon";
  return "Common";
}

export function createRarityIndex(records: RarityRecord[], excludedTraits: string[] = []): RarityIndex {
  const excluded = new Set(excludedTraits);
  const counts = new Map<string, Map<string, number>>();
  const scores = new Map<string, number>();

  for (const record of records) {
    let score = 0;
    for (const attribute of record.attributes) {
      if (excluded.has(attribute.trait_type) || !attribute.value || attribute.value === "—") continue;
      const values = counts.get(attribute.trait_type) ?? new Map<string, number>();
      values.set(attribute.value, (values.get(attribute.value) ?? 0) + 1);
      counts.set(attribute.trait_type, values);
    }
    scores.set(record.id, score);
  }

  for (const record of records) {
    let score = 0;
    for (const attribute of record.attributes) {
      if (excluded.has(attribute.trait_type) || !attribute.value || attribute.value === "—") continue;
      const count = counts.get(attribute.trait_type)?.get(attribute.value) ?? records.length;
      score += -Math.log2(Math.max(count / Math.max(records.length, 1), 1 / Math.max(records.length, 1)));
    }
    scores.set(record.id, score);
  }

  const ranking = [...records].sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
  const tokenRanks = new Map<string, TokenRarity>();
  ranking.forEach((record, index) => {
    const rank = index + 1;
    tokenRanks.set(record.id, { score: scores.get(record.id) ?? 0, rank, total: records.length, percentile: rank / Math.max(records.length, 1), tier: tierFromRank(rank, records.length) });
  });

  return {
    trait(record, attribute) {
      const count = counts.get(attribute.trait_type)?.get(attribute.value) ?? 0;
      const percentage = (count / Math.max(records.length, 1)) * 100;
      return { count, total: records.length, percentage, tier: tierFromPrevalence(percentage) };
    },
    token(record) {
      return tokenRanks.get(record.id) ?? { score: 0, rank: records.length, total: records.length, percentile: 1, tier: "Common" };
    },
  };
}
