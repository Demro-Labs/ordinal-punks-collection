import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
} from "lucide-react";
import {
  describeFeeSources,
  getMempoolConfig,
  getRecommendedFeeEstimate,
  getSpendableUtxos,
  InsufficientSafeUtxosError,
  trackMempoolTransaction,
  validateMempoolAddress,
  type MempoolReceipt,
} from "@/lib/mempool";
import { normalizeUniSatTxid } from "@/lib/native-fb-send";
import { sendNativeUniSatRunes } from "@/lib/native-unisat-actions";
import { isMobileUniSatDevice } from "@/lib/mobile-context";
import {
  fetchRuneBalance,
  fetchRuneBalancePage,
  formatRuneAmount,
  parseRuneAmountToBaseUnits,
  type RuneBalance,
  type RuneNetwork,
} from "@/lib/runes";
import { UniSatMobileOpenDappLink } from "@/components/UniSatMobileOpenDappLink";
import { UniSatOwnershipProof } from "@/components/UniSatOwnershipProof";

const PAGE_SIZE = 20;
const MINIMUM_RUNE_FEE_UTXO_SATS = 1_200;
const RUNE_FEE_VBYTES_RESERVE = 500;
type Chain = { enum?: string; name?: string };
type Provider = {
  sendRunes?: (
    recipient: string,
    runeid: string,
    amount: string,
    options?: { feeRate?: number }
  ) => Promise<unknown>;
  getAccounts?: () => Promise<string[]>;
  getChain?: () => Promise<Chain>;
  signMessage?: (message: string, type: "ecdsa" | "bip322-simple") => Promise<string>;
};
type PreparedTransfer = {
  contextKey: string;
  feeRate: number;
  feeSource: string;
  safeFeeSats: number;
  expiresAt: number;
};
type RuneReceipt = {
  txid: string;
  network: string;
  networkEnum: RuneNetwork;
  sender: string;
  recipient: string;
  runeid: string;
  rune: string;
  amount: string;
  feeRate: number;
  feeSource: string;
  createdAt: string;
  mempool: MempoolReceipt;
};

function getProvider(): Provider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { unisat?: Provider }).unisat;
}
function storageKey(address: string, network: RuneNetwork) {
  if (network === "FRACTAL_BITCOIN_MAINNET")
    return `fractal-runes-send:v1:${address.toLowerCase()}`;
  return `runes-send:v1:${network}:${address.toLowerCase()}`;
}
function saveReceipt(receipt: RuneReceipt) {
  try {
    localStorage.setItem(
      storageKey(receipt.sender, receipt.networkEnum),
      JSON.stringify(receipt)
    );
  } catch {
    /* Private mode or storage quota. */
  }
}
function readReceipt(address: string, network: RuneNetwork): RuneReceipt | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(storageKey(address, network)) ?? "null"
    ) as Partial<RuneReceipt> | null;
    if (
      !value ||
      typeof value.txid !== "string" ||
      !/^[a-f0-9]{64}$/i.test(value.txid) ||
      (value.networkEnum !== network &&
        !(network === "FRACTAL_BITCOIN_MAINNET" && value.network === "Fractal Bitcoin")) ||
      value.sender !== address ||
      typeof value.recipient !== "string" ||
      typeof value.runeid !== "string" ||
      typeof value.rune !== "string" ||
      typeof value.amount !== "string" ||
      !Number.isFinite(value.feeRate) ||
      typeof value.feeSource !== "string" ||
      typeof value.createdAt !== "string" ||
      !value.mempool ||
      value.mempool.txid !== value.txid
    )
      return null;
    return value as RuneReceipt;
  } catch {
    return null;
  }
}

export function UniSatRunesSendPanel({
  site,
  address,
  chain,
  onWalletRefresh,
}: {
  site: "punks" | "pokedex";
  address: string;
  chain: Chain | null;
  onWalletRefresh: () => void;
}) {
  const provider = getProvider();
  const network: RuneNetwork | null =
    chain?.enum === "BITCOIN_MAINNET" ||
    chain?.enum === "FRACTAL_BITCOIN_MAINNET"
      ? chain.enum
      : null;
  const networkLabel = network === "BITCOIN_MAINNET" ? "Bitcoin" : "Fractal Bitcoin";
  const connected = Boolean(address && network);
  const [balances, setBalances] = useState<RuneBalance[]>([]);
  const [totalBalances, setTotalBalances] = useState(0);
  const [nextStart, setNextStart] = useState(0);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [balanceError, setBalanceError] = useState("");
  const [selectedRuneId, setSelectedRuneId] = useState("");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [confirmedContextKey, setConfirmedContextKey] = useState("");
  const [ownershipProofKey, setOwnershipProofKey] = useState<string | null>(
    null
  );
  const [ownershipProofVersion, setOwnershipProofVersion] = useState(0);
  const [prepared, setPrepared] = useState<PreparedTransfer | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [feeEstimate, setFeeEstimate] = useState<{
    feeRate: number;
    feeSource: string;
  } | null>(null);
  const [receipt, setReceipt] = useState<RuneReceipt | null>(() =>
    address && network ? readReceipt(address, network) : null
  );
  const [outcomeUnclear, setOutcomeUnclear] = useState(() => {
    try {
      return (
        typeof window !== "undefined" &&
        Boolean(address && network) &&
        sessionStorage.getItem(`${storageKey(address, network!)}:unclear`) === "1"
      );
    } catch {
      return false;
    }
  });
  const [outcomeChecked, setOutcomeChecked] = useState(false);
  const balanceRequestId = useRef(0);
  const runningTxid = useRef("");
  const selectedRune =
    balances.find(item => item.runeid === selectedRuneId) ?? null;
  const amountBaseUnits = selectedRune
    ? parseRuneAmountToBaseUnits(
        amount,
        selectedRune.divisibility,
        selectedRune.amount
      )
    : null;
  const transferContextKey =
    selectedRune && amountBaseUnits && recipient.trim()
      ? JSON.stringify([
          address.toLowerCase(),
          chain?.enum,
          selectedRune.runeid,
          recipient.trim(),
          amount.trim(),
          amountBaseUnits,
        ])
      : "";
  const confirmed =
    Boolean(transferContextKey) && confirmedContextKey === transferContextKey;
  const preparedIsCurrent = Boolean(
    prepared &&
      transferContextKey &&
      prepared.contextKey === transferContextKey &&
      Date.now() < prepared.expiresAt
  );

  const loadBalances = async (start = 0, replace = true) => {
    if (!address || !network) return;
    const requestId = ++balanceRequestId.current;
    setBalancesLoading(true);
    setBalanceError("");
    try {
      const page = await fetchRuneBalancePage(address, network, start, PAGE_SIZE);
      if (requestId !== balanceRequestId.current) return;
      setBalances(current => {
        if (replace) return page.detail;
        const byId = new Map(current.map(item => [item.runeid, item]));
        page.detail.forEach(item => byId.set(item.runeid, item));
        const merged: RuneBalance[] = [];
        byId.forEach(item => merged.push(item));
        return merged;
      });
      setTotalBalances(page.total);
      setNextStart(page.start + page.detail.length);
      if (replace && !selectedRuneId && page.detail[0])
        setSelectedRuneId(page.detail[0].runeid);
    } catch (cause) {
      if (requestId === balanceRequestId.current)
        setBalanceError(
          cause instanceof Error
            ? cause.message
            : "Unable to load live Rune balances."
        );
    } finally {
      if (requestId === balanceRequestId.current) setBalancesLoading(false);
    }
  };

  useEffect(() => {
    balanceRequestId.current += 1;
    setBalances([]);
    setTotalBalances(0);
    setNextStart(0);
    setSelectedRuneId("");
    setRecipient("");
    setAmount("");
    setConfirmedContextKey("");
    setOwnershipProofKey(null);
    setOwnershipProofVersion(version => version + 1);
    setPrepared(null);
    setError("");
    setReceipt(address && network ? readReceipt(address, network) : null);
    try {
      setOutcomeUnclear(
        Boolean(address && network) &&
          sessionStorage.getItem(`${storageKey(address, network!)}:unclear`) === "1"
      );
    } catch {
      setOutcomeUnclear(false);
    }
    setOutcomeChecked(false);
    if (connected) void loadBalances(0, true);
    // The account/network key intentionally resets all Rune transfer context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, chain?.enum]);

  useEffect(() => {
    if (!connected || !network) {
      setFeeEstimate(null);
      return;
    }
    let active = true;
    const refresh = async () => {
      try {
        const estimate = await getRecommendedFeeEstimate(network);
        if (active)
          setFeeEstimate({
            feeRate: Math.ceil(estimate.feeRate),
            feeSource: describeFeeSources(estimate.strategy, estimate.sources),
          });
      } catch {
        if (active) setFeeEstimate(null);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [connected, network]);

  useEffect(() => {
    if (!receipt || runningTxid.current === receipt.txid) return;
    const txid = receipt.txid;
    let active = true;
    runningTxid.current = txid;
    void trackMempoolTransaction(txid, receipt.networkEnum, update => {
      if (!active) return;
      setReceipt(current => {
        if (!current || current.txid !== txid) return current;
        const next = { ...current, mempool: update };
        saveReceipt(next);
        return next;
      });
    })
      .catch(cause => {
        if (!active) return;
        setReceipt(current => {
          if (!current || current.txid !== txid) return current;
          const next = {
            ...current,
            mempool: {
              ...current.mempool,
              status: "error" as const,
              message:
                cause instanceof Error
                  ? cause.message
                  : "Mempool tracking is unavailable.",
              checkedAt: new Date().toISOString(),
            },
          };
          saveReceipt(next);
          return next;
        });
      })
      .finally(() => {
        if (runningTxid.current === txid) runningTxid.current = "";
      });
    return () => {
      active = false;
    };
  }, [receipt?.txid]);

  const prepareTransfer = async () => {
    setError("");
    setPrepared(null);
    if (outcomeUnclear) {
      setError(
        "A previous Rune send has an uncertain outcome. Check UniSat and Mempool before preparing another transfer."
      );
      return;
    }
    if (
      !connected ||
      !network ||
      !provider?.sendRunes ||
      !provider.getAccounts ||
      !provider.getChain
    ) {
      setError(
        "Connect a UniSat wallet on Bitcoin or Fractal Bitcoin mainnet with sendRunes support. No transfer was requested."
      );
      return;
    }
    if (!selectedRune || !transferContextKey || !amountBaseUnits) {
      setError(
        "Choose a Rune and enter an amount within its available balance and divisibility."
      );
      return;
    }
    if (!confirmed) {
      setError(
        "Review and confirm the Rune, recipient, amount and active network first."
      );
      return;
    }
    if (ownershipProofKey !== transferContextKey) {
      setError(
        "Complete the wallet ownership check for this exact Rune transfer before preflight."
      );
      return;
    }
    const to = recipient.trim();
    if (!to || to.length > 100) {
      setError(`Enter a valid ${networkLabel} recipient address.`);
      return;
    }
    setPreparing(true);
    try {
      const [accounts, currentChain] = await Promise.all([
        provider.getAccounts(),
        provider.getChain(),
      ]);
      if (currentChain.enum !== network || !accounts.includes(address))
        throw new Error(
          "The UniSat account or network changed. Reconnect the intended address and network."
        );
      await validateMempoolAddress(network, to);
      const currentBalance = await fetchRuneBalance(
        address,
        network,
        selectedRune.runeid
      );
      if (
        currentBalance.divisibility !== selectedRune.divisibility ||
        !parseRuneAmountToBaseUnits(
          amount,
          currentBalance.divisibility,
          currentBalance.amount
        )
      ) {
        throw new Error(
          "The live Rune balance or divisibility changed. Refresh the balance list and review the amount."
        );
      }
      const estimate = await getRecommendedFeeEstimate(network);
      const feeRate = Math.ceil(estimate.feeRate);
      if (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > 10_000)
        throw new Error(
          `The live ${networkLabel} fee estimate is invalid; no transfer was requested.`
        );
      const minimumSafeFeeSats = Math.max(
        MINIMUM_RUNE_FEE_UTXO_SATS,
        feeRate * RUNE_FEE_VBYTES_RESERVE + 600
      );
      const safeFeeUtxos = await getSpendableUtxos(
        network,
        address,
        minimumSafeFeeSats,
        { mobile: isMobileUniSatDevice() }
      );
      const safeFeeSats = safeFeeUtxos.reduce(
        (sum, utxo) => sum + utxo.satoshi,
        0
      );
      if (safeFeeSats < minimumSafeFeeSats)
        throw new Error(
          `Not enough confirmed, asset-free ${network === "BITCOIN_MAINNET" ? "BTC" : "FB"} UTXOs were verified to cover a conservative Rune-transfer fee reserve. No transfer was requested.`
        );
      setFeeEstimate({
        feeRate,
        feeSource: describeFeeSources(estimate.strategy, estimate.sources),
      });
      setPrepared({
        contextKey: transferContextKey,
        feeRate,
        feeSource: describeFeeSources(estimate.strategy, estimate.sources),
        safeFeeSats,
        expiresAt: Date.now() + 120_000,
      });
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "Rune transfer preflight failed. No transfer was requested.";
      const mobileFundingGuidance =
        isMobileUniSatDevice() && cause instanceof InsufficientSafeUtxosError
          ? ` Sur mobile, ajoutez un UTXO ${network === "BITCOIN_MAINNET" ? "BTC" : "FB"} confirmé distinct couvrant le minimum indiqué et la marge de frais, sans Ordinal, Rune ni Alkane, puis relancez la vérification. Le solde Rune ne paie pas les frais réseau. Cette vérification n’a ouvert aucune approbation UniSat et n’a lancé aucune transaction.`
          : "";
      setError(`${message}${mobileFundingGuidance}`);
    } finally {
      setPreparing(false);
    }
  };

  const openWalletApproval = () => {
    setError("");
    const activeProvider = getProvider();
    const activeNetwork = network;
    const mempoolConfig = activeNetwork ? getMempoolConfig(activeNetwork) : undefined;
    if (outcomeUnclear) {
      setError(
        "A previous Rune send has an uncertain outcome. Check UniSat and Mempool before retrying."
      );
      return;
    }
    if (
      !activeNetwork ||
      !mempoolConfig ||
      !activeProvider?.sendRunes ||
      !selectedRune ||
      !prepared ||
      !preparedIsCurrent ||
      !confirmed ||
      !transferContextKey ||
      !amountBaseUnits
    ) {
      setPrepared(null);
      setError(
        "The transfer preview or preflight is no longer valid. Prepare the transfer again."
      );
      return;
    }
    if (Date.now() >= (prepared?.expiresAt ?? 0)) {
      setPrepared(null);
      setError(
        "The preflight expired. Refresh the live balance and fee estimate before continuing."
      );
      return;
    }
    if (ownershipProofKey !== transferContextKey) {
      setPrepared(null);
      setError(
        "The wallet ownership check is missing or expired. Complete it again before opening UniSat."
      );
      return;
    }
    const to = recipient.trim();
    const runeId = selectedRune.runeid;
    const displayAmount = amount.trim();
    const feeRate = prepared.feeRate;
    const feeSource = prepared.feeSource;
    setSending(true);
    setPrepared(null);
    setOwnershipProofKey(null);
    setOwnershipProofVersion(version => version + 1);
    let sendPromise: Promise<unknown>;
    try {
      // Call UniSat synchronously in this explicit tap so mobile wallet prompts retain the user gesture.
      sendPromise = sendNativeUniSatRunes(
        activeProvider,
        to,
        runeId,
        displayAmount,
        feeRate
      );
    } catch (cause) {
      setSending(false);
      setError(
        cause instanceof Error
          ? cause.message
          : "UniSat could not open the Rune transfer approval."
      );
      return;
    }
    void Promise.resolve(sendPromise)
      .then(result => {
        const txid = normalizeUniSatTxid(result);
        if (!txid) {
          setOutcomeUnclear(true);
          try {
            sessionStorage.setItem(`${storageKey(address, activeNetwork)}:unclear`, "1");
          } catch {
            /* In-memory safety lock remains. */
          }
          throw new Error(
            "UniSat did not return a valid transaction ID. The outcome is uncertain; check UniSat and Mempool before retrying."
          );
        }
        const mempool: MempoolReceipt = {
          txid,
          network: mempoolConfig.label,
          status: "checking",
          message: "Searching for the transaction in Mempool…",
          blockHeight: null,
          explorerUrl: `${mempoolConfig.explorer}${encodeURIComponent(txid)}`,
          checkedAt: new Date().toISOString(),
        };
        const next: RuneReceipt = {
          txid,
          network: mempoolConfig.label,
          networkEnum: activeNetwork,
          sender: address,
          recipient: to,
          runeid: runeId,
          rune: selectedRune.spacedRune || selectedRune.rune,
          amount: displayAmount,
          feeRate,
          feeSource,
          createdAt: new Date().toISOString(),
          mempool,
        };
        setReceipt(next);
        saveReceipt(next);
        setOutcomeUnclear(false);
        try {
          sessionStorage.removeItem(`${storageKey(address, activeNetwork)}:unclear`);
        } catch {
          /* Receipt remains available. */
        }
        setRecipient("");
        setAmount("");
        setConfirmedContextKey("");
        onWalletRefresh();
        window.setTimeout(onWalletRefresh, 3000);
        void loadBalances(0, true);
      })
      .catch(cause => {
        const message = cause instanceof Error ? cause.message : String(cause);
        const code =
          cause && typeof cause === "object"
            ? (cause as { code?: unknown }).code
            : undefined;
        const cancelled =
          code === 4001 ||
          /user (rejected|denied)|cancelled by user|request rejected/i.test(
            message
          );
        if (!cancelled) {
          setOutcomeUnclear(true);
          try {
            sessionStorage.setItem(`${storageKey(address, activeNetwork)}:unclear`, "1");
          } catch {
            /* In-memory safety lock remains. */
          }
        }
        setError(message || "UniSat rejected the Rune transfer.");
      })
      .finally(() => setSending(false));
  };

  return (
    <section
      className="mt-4 border border-[#d99a54]/50 bg-[#10151a] p-3 sm:p-4"
      aria-labelledby="runes-send-title"
    >
      <UniSatMobileOpenDappLink
        site={site}
        walletMethodAvailable={typeof provider?.sendRunes === "function"}
        methodLabel="sendRunes"
      />
      <div className="flex items-start gap-2">
        <Send size={15} className="mt-0.5 shrink-0 text-[#f2bd63]" />
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-[#d99a54]">
            UniSat · {network ? `${networkLabel} mainnet` : "Bitcoin / Fractal"}
          </p>
          <h3
            id="runes-send-title"
            className="mt-1 font-display text-lg text-[#f3efe5]"
          >
            Envoyer des Runes
          </h3>
          <p className="mt-1 font-mono text-[10px] leading-5 text-[#9ea7b3]">
            Desktop et mobile si le provider UniSat expose{" "}
            <code>sendRunes</code>. Les soldes viennent de l’indexeur du réseau actif;
            UniSat construit, signe et diffuse la transaction après ton
            approbation.
          </p>
        </div>
      </div>
      {!connected ? (
        <p
          className="mt-3 border border-[#3b434d] p-3 font-mono text-[10px] text-[#e0b45f]"
          role="status"
        >
          Connecte UniSat à Bitcoin ou Fractal Bitcoin mainnet pour consulter et
          envoyer des Runes.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-[10px] text-[#9ea7b3]">
              Soldes Runes live pour{" "}
              <span className="text-[#f2bd63]">
                {address.slice(0, 10)}…{address.slice(-6)}
              </span>{" "}
              · {balances.length} / {totalBalances}
            </p>
            <button
              type="button"
              onClick={() => void loadBalances(0, true)}
              disabled={balancesLoading}
              className="inline-flex min-h-10 items-center gap-2 border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#9ea7b3] disabled:opacity-40"
            >
              <RefreshCw
                size={12}
                className={balancesLoading ? "animate-spin" : ""}
              />{" "}
              Actualiser
            </button>
          </div>
          {balances.length > 0 ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="rune-select"
                  className="font-mono text-[9px] uppercase text-[#718092]"
                >
                  Rune à envoyer
                </label>
                <select
                  id="rune-select"
                  value={selectedRuneId}
                  onChange={event => {
                    setSelectedRuneId(event.target.value);
                    setAmount("");
                    setPrepared(null);
                  }}
                  className="mt-1 min-h-11 w-full border border-[#3b434d] bg-[#0f1317] px-3 py-2 font-mono text-[10px] text-[#f3efe5] focus:border-[#d99a54]"
                >
                  {balances.map(item => (
                    <option key={item.runeid} value={item.runeid}>
                      {item.spacedRune} ·{" "}
                      {formatRuneAmount(item.amount, item.divisibility)}
                      {item.symbol ? ` ${item.symbol}` : ""} · {item.runeid}
                    </option>
                  ))}
                </select>
                {selectedRune && (
                  <p className="mt-1 break-all font-mono text-[9px] text-[#718092]">
                    Rune ID {selectedRune.runeid} · divisibilité{" "}
                    {selectedRune.divisibility} · solde{" "}
                    {formatRuneAmount(
                      selectedRune.amount,
                      selectedRune.divisibility
                    )}
                    {selectedRune.symbol ? ` ${selectedRune.symbol}` : ""}
                  </p>
                )}
              </div>
              <div>
                <label
                  htmlFor="rune-recipient"
                  className="font-mono text-[9px] uppercase text-[#718092]"
                >
                  Adresse destinataire · {networkLabel}
                </label>
                <input
                  id="rune-recipient"
                  value={recipient}
                  onChange={event => {
                    setRecipient(event.target.value.trim());
                    setPrepared(null);
                  }}
                  maxLength={100}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="bc1… / 1…"
                  className="mt-1 min-h-11 w-full border border-[#3b434d] bg-[#0f1317] px-3 py-2 font-mono text-[10px] text-[#f3efe5] outline-none placeholder:text-[#66717e] focus:border-[#d99a54]"
                />
              </div>
              <div>
                <label
                  htmlFor="rune-amount"
                  className="font-mono text-[9px] uppercase text-[#718092]"
                >
                  Montant
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    id="rune-amount"
                    value={amount}
                    onChange={event => {
                      setAmount(event.target.value);
                      setPrepared(null);
                    }}
                    inputMode="decimal"
                    maxLength={80}
                    autoComplete="off"
                    placeholder={
                      selectedRune
                        ? `Jusqu’à ${formatRuneAmount(selectedRune.amount, selectedRune.divisibility)}`
                        : "0"
                    }
                    className="min-h-11 min-w-0 flex-1 border border-[#3b434d] bg-[#0f1317] px-3 py-2 font-mono text-[10px] text-[#f3efe5] outline-none placeholder:text-[#66717e] focus:border-[#d99a54]"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedRune) {
                        setAmount(
                          formatRuneAmount(
                            selectedRune.amount,
                            selectedRune.divisibility
                          )
                        );
                        setPrepared(null);
                      }
                    }}
                    disabled={!selectedRune}
                    className="min-h-11 border border-[#3b434d] px-3 font-mono text-[9px] uppercase text-[#9ea7b3] disabled:opacity-40"
                  >
                    Max
                  </button>
                </div>
                <p className="mt-1 font-mono text-[9px] text-[#718092]">
                  Séparateur décimal « . »; précision maximale :{" "}
                  {selectedRune?.divisibility ?? 0}.
                </p>
              </div>
              <div className="border border-[#3b434d] bg-[#151a1f] p-3 font-mono text-[10px] leading-5 text-[#9ea7b3]">
                <p className="flex items-center gap-2 text-[#f2bd63]">
                  <ShieldCheck size={12} /> Frais en {network === "BITCOIN_MAINNET" ? "BTC" : "FB"} · jamais en Runes
                </p>
                <p className="mt-1">
                  La vérification requiert un UTXO confirmé sans inscription,
                  Rune ni Alkane. UniSat affiche les détails finaux de la
                  transaction.
                </p>
                {feeEstimate && (
                  <p className="mt-1">
                    Estimation live : {feeEstimate.feeRate} sat/vB ·{" "}
                    {feeEstimate.feeSource}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <p className="mt-3 border border-[#3b434d] p-3 font-mono text-[10px] text-[#718092]">
              {balancesLoading
                ? `Chargement des soldes Runes ${networkLabel}…`
                : "Aucun solde Rune trouvé dans la première page."}
            </p>
          )}
          {balanceError && (
            <p
              className="mt-2 font-mono text-[10px] text-[#e08b7d]"
              role="alert"
            >
              {balanceError}
            </p>
          )}
          {balances.length < totalBalances && (
            <button
              type="button"
              onClick={() => void loadBalances(nextStart, false)}
              disabled={balancesLoading}
              className="mt-2 min-h-10 border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#9ea7b3] disabled:opacity-40"
            >
              {balancesLoading
                ? "Chargement…"
                : `Charger plus (${balances.length} / ${totalBalances})`}
            </button>
          )}
          {selectedRune && (
            <div className="mt-4 border-t border-[#2c323a] pt-4">
              <div className="border border-[#3b434d] bg-[#151a1f] p-3 font-mono text-[10px] leading-5 text-[#d9d3c6]">
                <p className="uppercase tracking-[0.08em] text-[#f2bd63]">
                  Vérifie le récapitulatif avant l’approbation UniSat
                </p>
                <p className="mt-1 break-all">
                  Réseau : {networkLabel} mainnet
                </p>
                <p>
                  Actif : {selectedRune.spacedRune} · {selectedRune.runeid}
                </p>
                <p>
                  Montant : {amount || "—"}
                  {selectedRune.symbol ? ` ${selectedRune.symbol}` : ""} · solde
                  affiché{" "}
                  {formatRuneAmount(
                    selectedRune.amount,
                    selectedRune.divisibility
                  )}
                </p>
                <p className="break-all">Destinataire : {recipient || "—"}</p>
                <p>
                  Frais réseau payés en {network === "BITCOIN_MAINNET" ? "BTC" : "FB"} : taux estimé live affiché ci-dessus;
                  le wallet présente le montant final.
                </p>
              </div>
              <label className="mt-3 flex items-start gap-2 font-mono text-[10px] leading-5 text-[#9ea7b3]">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={event =>
                    setConfirmedContextKey(
                      event.target.checked ? transferContextKey : ""
                    )
                  }
                  disabled={!transferContextKey}
                  className="mt-1 accent-[#d99a54]"
                />
                <span>
                  Je confirme le réseau, le Rune, le montant et l’adresse
                  destinataire ci-dessus; je vérifierai aussi le récapitulatif
                  final dans UniSat.
                </span>
              </label>
              {confirmed && transferContextKey && (
                <UniSatOwnershipProof
                  key={`${transferContextKey}:${ownershipProofVersion}`}
                  site={site}
                  address={address}
                  network={chain?.enum ?? ""}
                  provider={provider}
                  contextKey={transferContextKey}
                  onVerified={setOwnershipProofKey}
                />
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void prepareTransfer()}
                  disabled={
                    preparing ||
                    sending ||
                    !confirmed ||
                    ownershipProofKey !== transferContextKey ||
                    !provider?.sendRunes ||
                    outcomeUnclear
                  }
                  className="inline-flex min-h-11 items-center gap-2 border border-[#3b434d] px-4 py-2 font-mono text-[9px] uppercase tracking-[0.08em] text-[#d9d3c6] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {preparing ? (
                    <>
                      <Loader2 size={12} className="animate-spin" />{" "}
                      Vérification live…
                    </>
                  ) : (
                    "1 · Vérifier le transfert"
                  )}
                </button>
                {preparedIsCurrent && (
                  <button
                    type="button"
                    onClick={openWalletApproval}
                    disabled={
                      sending ||
                      !confirmed ||
                      ownershipProofKey !== transferContextKey
                    }
                    className="inline-flex min-h-11 items-center gap-2 border border-[#d99a54] bg-[#d99a54] px-4 py-2 font-mono text-[9px] uppercase tracking-[0.08em] text-[#0b0d10] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {sending ? (
                      <>
                        <Loader2 size={12} className="animate-spin" /> UniSat…
                      </>
                    ) : (
                      "2 · Ouvrir l’approbation UniSat"
                    )}
                  </button>
                )}
              </div>
              {preparedIsCurrent && (
                <p
                  className="mt-2 font-mono text-[9px] text-[#70c7a0]"
                  role="status"
                >
                  <CheckCircle2 size={12} className="mr-1 inline" />{" "}
                  Vérification réussie :{" "}
                  {prepared?.safeFeeSats.toLocaleString()} sats confirmés sans
                  actifs pour couvrir la réserve de frais. Valable jusqu’à{" "}
                  {new Date(prepared!.expiresAt).toLocaleTimeString()}.
                </p>
              )}
            </div>
          )}
          {outcomeUnclear && (
            <div
              className="mt-3 border border-[#a45e54] bg-[#241715] p-3 font-mono text-[10px] leading-5 text-[#f3b0a4]"
              role="alert"
            >
              <p>
                Le résultat d’une tentative précédente est incertain. Ne relance
                pas le transfert avant d’avoir vérifié UniSat et Mempool.
              </p>
              <label className="mt-2 flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={outcomeChecked}
                  onChange={event => setOutcomeChecked(event.target.checked)}
                  className="mt-1 accent-[#d99a54]"
                />
                <span>
                  J’ai vérifié l’activité UniSat et Mempool : aucun transfert de
                  cette tentative n’est en attente ou confirmé.
                </span>
              </label>
              <button
                type="button"
                onClick={() => {
                  try {
                    if (network) sessionStorage.removeItem(`${storageKey(address, network)}:unclear`);
                  } catch {
                    /* In-memory lock can be cleared after explicit check. */
                  }
                  setOutcomeUnclear(false);
                  setOutcomeChecked(false);
                  setError("");
                }}
                disabled={!outcomeChecked}
                className="mt-2 border border-[#a45e54] px-3 py-2 uppercase tracking-[0.06em] text-[#f3efe5] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Déverrouiller après vérification
              </button>
            </div>
          )}
          {error && (
            <p
              className="mt-3 border border-[#a45e54]/50 bg-[#241715] p-3 font-mono text-[10px] leading-5 text-[#f3b0a4]"
              role="alert"
            >
              {error}
            </p>
          )}
          {receipt && (
            <div className="mt-4 border border-[#3b434d] bg-[#151a1f] p-3 font-mono text-[10px] leading-5 text-[#9ea7b3]">
              <p className="text-[#f2bd63]">
                Dernier transfert Runes · {receipt.mempool.status}
              </p>
              <p>
                {receipt.rune} · {receipt.amount} · {receipt.feeRate} sat/vB (
                {receipt.feeSource})
              </p>
              <p className="break-all">TXID : {receipt.txid}</p>
              <p>{receipt.mempool.message}</p>
              <a
                href={receipt.mempool.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex min-h-10 items-center gap-2 border border-[#d99a54] px-3 py-2 text-[#f2bd63]"
              >
                Suivre dans Mempool <ExternalLink size={12} />
              </a>
            </div>
          )}
        </>
      )}
    </section>
  );
}
