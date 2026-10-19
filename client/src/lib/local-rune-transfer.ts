import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import type { AddressType, OrdiNetwork, OrdiWalletRecord } from "@/lib/ordi-wallet";
import { fetchAddressOrdinals } from "@/lib/ordinals";
import { fetchRuneBalance, fetchRuneUtxoPage, parseRuneAmountToBaseUnits, type RuneUtxo } from "@/lib/runes";
import { getMempoolConfig, getMempoolRawTransaction, getRecommendedFeeEstimate, getSpendableUtxos, validateMempoolAddress, type SpendableUtxo } from "@/lib/mempool";

bitcoin.initEccLib(ecc);
const NET = bitcoin.networks.bitcoin;
const DUST = 1_200;
const MAX_INPUTS = 20;
const INPUT_VBYTES: Record<AddressType, number> = { legacy: 150, "nested-segwit": 93, "native-segwit": 69, taproot: 59 };

export type LocalRuneTransferPlan = {
  network: OrdiNetwork; addressType: AddressType; sourceAddress: string; recipient: string;
  runeid: string; runeName: string; divisibility: number; amount: string; amountBaseUnits: string;
  runeInputs: RuneUtxo[]; feeInputs: Array<Pick<SpendableUtxo, "txid" | "vout" | "satoshi" | "scriptPk">>;
  psbtHex: string; runestoneHex: string; inputSats: number; outputSats: number; feeSats: number;
  feeRateSatVb: number; runeChangeBaseUnits: string; ownedOrdinals: Array<{ inscriptionId: string; location: string | null }>;
};
const outpoint = (txid: string, vout: number) => `${txid.toLowerCase()}:${vout}`;
const varIntSize = (n: number) => n < 0xfd ? 1 : n <= 0xffff ? 3 : 5;
function encodeVarint(n: bigint): Buffer {
  if (n < 0n) throw new Error("Unsigned Runestone varint expected.");
  const bytes: number[] = [];
  while (n >= 0x80n) { bytes.push(Number(n & 0x7fn) | 0x80); n >>= 7n; }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}
export function buildLocalRunestoneScript(runeid: string, amount: string, change: string) {
  if (!/^\d{1,20}:\d{1,20}$/.test(runeid) || !/^\d{1,80}$/.test(amount) || !/^\d{1,80}$/.test(change) || BigInt(amount) <= 0n) throw new Error("Invalid Rune ID or amount.");
  const [blockText, txText] = runeid.split(":");
  const fields = [0n, BigInt(blockText), BigInt(txText), BigInt(amount), 1n];
  if (BigInt(change) > 0n) fields.push(0n, 0n, BigInt(change), 2n);
  return Buffer.from(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, bitcoin.opcodes.OP_13, Buffer.concat(fields.map(encodeVarint))]));
}
function scriptFor(address: string) { return Buffer.from(bitcoin.address.toOutputScript(address, NET)); }
async function allRuneUtxos(address: string, network: OrdiNetwork, runeid: string) {
  const first = await fetchRuneUtxoPage(address, network, runeid, 0, 25);
  if (first.total > 100) throw new Error("More than 100 Rune UTXOs; complete pagination is required before local signing.");
  const items = [...first.utxo];
  for (let start = 25; start < first.total; start += 25) {
    const page = await fetchRuneUtxoPage(address, network, runeid, start, 25);
    if (page.total !== first.total || page.start !== start) throw new Error("Rune index changed during pagination.");
    items.push(...page.utxo);
  }
  if (items.length !== first.total) throw new Error("Rune UTXO index is incomplete.");
  return items;
}
function signerFor(account: OrdiWalletRecord["addresses"][AddressType], type: AddressType) {
  const pub = Buffer.from(account.publicKey, "hex"), priv = Buffer.from(account.privateKey, "hex");
  if (pub.length !== 33 || priv.length !== 32 || !ecc.isPrivate(priv) || !Buffer.from(ecc.pointFromScalar(priv, true) ?? []).equals(pub)) throw new Error("Local private key does not match the selected account.");
  if (type !== "taproot") return { publicKey: pub, sign: (h: Uint8Array) => Buffer.from(ecc.sign(h, priv)) };
  const adjusted = pub[0] === 3 ? Buffer.from(ecc.privateNegate(priv)) : priv;
  const tweaked = ecc.privateAdd(adjusted, bitcoin.crypto.taggedHash("TapTweak", bitcoin.toXOnly(pub)));
  if (!tweaked) throw new Error("Taproot key tweak failed.");
  const tweakedPub = ecc.pointFromScalar(tweaked, true);
  if (!tweakedPub) throw new Error("Taproot public key derivation failed.");
  return { publicKey: Buffer.from(tweakedPub), sign: (h: Uint8Array) => Buffer.from(ecc.sign(h, tweaked)), signSchnorr: (h: Uint8Array) => Buffer.from(ecc.signSchnorr(h, tweaked)) };
}
function addInput(psbt: bitcoin.Psbt, item: { txid: string; vout: number; satoshi: number; scriptPk: string; rawTx?: string }, type: AddressType, pub: Buffer) {
  const base = { hash: item.txid, index: item.vout, sequence: 0xfffffffd };
  const script = Buffer.from(item.scriptPk, "hex");
  if (type === "legacy") {
    if (!item.rawTx) throw new Error("Legacy input missing previous transaction.");
    const prev = bitcoin.Transaction.fromHex(item.rawTx), output = prev.outs[item.vout];
    if (prev.getId().toLowerCase() !== item.txid.toLowerCase() || !output || Number(output.value) !== item.satoshi || !Buffer.from(output.script).equals(script)) throw new Error("Legacy previous output does not match the live UTXO.");
    psbt.addInput({ ...base, nonWitnessUtxo: Buffer.from(item.rawTx, "hex") });
  } else {
    const witnessUtxo = { script, value: BigInt(item.satoshi) };
    if (type === "nested-segwit") {
      const redeemScript = bitcoin.payments.p2wpkh({ pubkey: pub, network: NET }).output;
      if (!redeemScript) throw new Error("Nested SegWit redeem script unavailable.");
      psbt.addInput({ ...base, witnessUtxo, redeemScript });
    } else if (type === "taproot") psbt.addInput({ ...base, witnessUtxo, tapInternalKey: Buffer.from(ecc.xOnlyPointFromPoint(pub)) });
    else psbt.addInput({ ...base, witnessUtxo });
  }
}
function validateTx(raw: string, plan: LocalRuneTransferPlan) {
  const tx = bitcoin.Transaction.fromHex(raw);
  const expected = [...plan.runeInputs.map(x => outpoint(x.txid, x.vout)), ...plan.feeInputs.map(x => outpoint(x.txid, x.vout))];
  if (tx.ins.length !== expected.length || tx.outs.length !== 3) throw new Error("Final Rune transaction has unexpected inputs or outputs.");
  tx.ins.forEach((input, i) => { if (outpoint(Buffer.from(input.hash).reverse().toString("hex"), input.index) !== expected[i]) throw new Error("Final Rune inputs differ from the reviewed plan."); });
  if (Buffer.from(tx.outs[0].script).toString("hex") !== plan.runestoneHex || Number(tx.outs[0].value) !== 0) throw new Error("Runestone output differs from the reviewed plan.");
  if (!Buffer.from(tx.outs[1].script).equals(scriptFor(plan.recipient)) || Number(tx.outs[1].value) !== DUST) throw new Error("Rune recipient output differs from the reviewed plan.");
  if (!Buffer.from(tx.outs[2].script).equals(scriptFor(plan.sourceAddress)) || Number(tx.outs[2].value) !== plan.outputSats - DUST) throw new Error("Rune change output differs from the reviewed plan.");
  const inputSats = [...plan.runeInputs, ...plan.feeInputs].reduce((n, x) => n + x.satoshi, 0);
  const outputSats = tx.outs.reduce((n, x) => n + Number(x.value), 0);
  if (inputSats - outputSats !== plan.feeSats) throw new Error("Final Rune fee differs from the reviewed plan.");
  return tx;
}
export async function prepareLocalRuneTransfer(p: { network: OrdiNetwork; wallet: OrdiWalletRecord; addressType: AddressType; runeid: string; amount: string; recipient: string }): Promise<LocalRuneTransferPlan> {
  const account = p.wallet.addresses[p.addressType];
  if (!account?.address || !account.privateKey || !account.publicKey) throw new Error("Unlock the Local Vault and select a source account.");
  const recipient = p.recipient.trim();
  await validateMempoolAddress(p.network, recipient);
  const balance = await fetchRuneBalance(account.address, p.network, p.runeid);
  const amountBaseUnits = parseRuneAmountToBaseUnits(p.amount, balance.divisibility, balance.amount);
  if (!amountBaseUnits) throw new Error("Rune amount is invalid or exceeds the available balance.");
  const [utxos, ordinalIndex, feeEstimate] = await Promise.all([allRuneUtxos(account.address, p.network, p.runeid), fetchAddressOrdinals(account.address, p.network), getRecommendedFeeEstimate(p.network)]);
  if (ordinalIndex.detail.length !== ordinalIndex.total || ordinalIndex.detail.some(x => !x.location)) throw new Error("Ordinal index incomplete; Rune UTXOs cannot be proven inscription-free.");
  const inscribed = new Set(ordinalIndex.detail.map(x => x.location!.split(":").slice(0, 2).join(":").toLowerCase()));
  const safeRunes = utxos.filter(x => !inscribed.has(outpoint(x.txid, x.vout)) && x.confirmations > 0 && x.runes.length === 1 && x.runes[0].runeid === p.runeid);
  const indexed = safeRunes.reduce((n, x) => n + BigInt(x.runes[0].amount), 0n);
  if (indexed !== BigInt(balance.amount)) throw new Error("Rune balance and asset-safe UTXO sum disagree; signing is blocked.");
  const selected: RuneUtxo[] = [];
  let runeTotal = 0n;
  for (const x of [...safeRunes].sort((a,b) => BigInt(a.runes[0].amount) > BigInt(b.runes[0].amount) ? -1 : 1)) {
    selected.push(x); runeTotal += BigInt(x.runes[0].amount);
    if (runeTotal >= BigInt(amountBaseUnits)) break;
  }
  if (runeTotal < BigInt(amountBaseUnits)) throw new Error("Insufficient confirmed Rune UTXOs without other protocol assets.");
  const rate = Math.ceil(feeEstimate.feeRate);
  if (!Number.isSafeInteger(rate) || rate < 1 || rate > 1_000) throw new Error("Live fee rate is outside safe bounds.");
  const sourceScript = scriptFor(account.address), pub = Buffer.from(account.publicKey, "hex");
  const feeCandidates = (await getSpendableUtxos(p.network, account.address, DUST + rate * 500)).filter(x => !selected.some(r => outpoint(r.txid,r.vout) === outpoint(x.txid,x.vout)) && Buffer.from(x.scriptPk,"hex").equals(sourceScript));
  const runeChange = runeTotal - BigInt(amountBaseUnits);
  const runestone = buildLocalRunestoneScript(p.runeid, amountBaseUnits, runeChange.toString());
  const recipientScript = scriptFor(recipient);
  let feeInputs: SpendableUtxo[] = [], feeSats = 0, changeSats = 0;
  for (const candidate of feeCandidates) {
    if (selected.length + feeInputs.length + 1 > MAX_INPUTS) break;
    feeInputs.push(candidate);
    const vsize = 10 + (p.addressType === "legacy" ? 0 : 1) + (selected.length + feeInputs.length) * INPUT_VBYTES[p.addressType] + [runestone,recipientScript,sourceScript].reduce((n,s) => n + 8 + varIntSize(s.length) + s.length, 0);
    const fee = Math.ceil(vsize * rate);
    const totalSats = selected.reduce((n,x)=>n+x.satoshi,0) + feeInputs.reduce((n,x)=>n+x.satoshi,0);
    const change = totalSats - DUST - fee;
    if (change >= DUST) { feeSats = fee; changeSats = change; break; }
  }
  if (!feeSats || !changeSats) throw new Error("Confirmed asset-free fee UTXOs are insufficient.");
  const psbt = new bitcoin.Psbt({ network: NET });
  for (const x of selected) {
    const rawTx = await getMempoolRawTransaction(p.network, x.txid), prev = bitcoin.Transaction.fromHex(rawTx), output = prev.outs[x.vout];
    if (prev.getId().toLowerCase() !== x.txid || !output || Number(output.value) !== x.satoshi || !Buffer.from(output.script).equals(sourceScript)) throw new Error("Rune UTXO previous transaction does not match the local account.");
    addInput(psbt, { txid:x.txid,vout:x.vout,satoshi:x.satoshi,scriptPk:Buffer.from(output.script).toString("hex"),rawTx }, p.addressType, pub);
  }
  for (const x of feeInputs) {
    const rawTx = p.addressType === "legacy" ? await getMempoolRawTransaction(p.network, x.txid) : undefined;
    addInput(psbt, { txid:x.txid,vout:x.vout,satoshi:x.satoshi,scriptPk:x.scriptPk,rawTx }, p.addressType, pub);
  }
  psbt.addOutput({ script: runestone, value: 0n });
  psbt.addOutput({ address: recipient, value: BigInt(DUST) });
  psbt.addOutput({ address: account.address, value: BigInt(changeSats) });
  return { network:p.network,addressType:p.addressType,sourceAddress:account.address,recipient,runeid:p.runeid,runeName:balance.spacedRune,divisibility:balance.divisibility,amount:p.amount,amountBaseUnits,inputSats:selected.reduce((n,x)=>n+x.satoshi,0)+feeInputs.reduce((n,x)=>n+x.satoshi,0),outputSats:DUST+changeSats,feeSats,feeRateSatVb:rate,runeChangeBaseUnits:runeChange.toString(),runeInputs:selected,feeInputs:feeInputs.map(({txid,vout,satoshi,scriptPk})=>({txid,vout,satoshi,scriptPk})),psbtHex:psbt.toHex(),runestoneHex:runestone.toString("hex"),ownedOrdinals:ordinalIndex.detail };
}
async function assertCurrent(plan: LocalRuneTransferPlan) {
  const [utxos, ordinals, balance, safe] = await Promise.all([
    allRuneUtxos(plan.sourceAddress,plan.network,plan.runeid), fetchAddressOrdinals(plan.sourceAddress,plan.network),
    fetchRuneBalance(plan.sourceAddress,plan.network,plan.runeid),
    getSpendableUtxos(plan.network,plan.sourceAddress,1,{requiredOutpoints:plan.feeInputs.map(x=>outpoint(x.txid,x.vout))}),
  ]);
  if (ordinals.detail.length !== ordinals.total || ordinals.detail.some(x=>!x.location)) throw new Error("Ordinal index incomplete; no signature or broadcast.");
  const inscribed = new Set(ordinals.detail.map(x=>x.location!.split(":").slice(0,2).join(":").toLowerCase()));
  const runeMap = new Map(utxos.filter(x=>!inscribed.has(outpoint(x.txid,x.vout))).map(x=>[outpoint(x.txid,x.vout),x]));
  for (const x of plan.runeInputs) {
    const live = runeMap.get(outpoint(x.txid,x.vout));
    if (!live || live.satoshi !== x.satoshi || live.confirmations < 1 || live.runes.length !== 1 || live.runes[0].runeid !== plan.runeid || live.runes[0].amount !== x.runes[0].amount) throw new Error("Rune UTXO changed or acquired another asset.");
  }
  for (const x of plan.feeInputs) {
    const live = safe.find(y=>outpoint(y.txid,y.vout)===outpoint(x.txid,x.vout));
    if (!live || live.satoshi!==x.satoshi || live.scriptPk.toLowerCase()!==x.scriptPk.toLowerCase()) throw new Error("Fee UTXO is no longer safe.");
  }
  const indexed = utxos.filter(x=>!inscribed.has(outpoint(x.txid,x.vout))&&x.runes.length===1&&x.runes[0].runeid===plan.runeid).reduce((n,x)=>n+BigInt(x.runes[0].amount),0n);
  if (indexed!==BigInt(balance.amount)) throw new Error("Rune balance and UTXO index disagree.");
}
export async function signLocalRuneTransfer(plan: LocalRuneTransferPlan, wallet: OrdiWalletRecord) {
  if (wallet.addresses[plan.addressType]?.address!==plan.sourceAddress) throw new Error("Local source account changed.");
  await assertCurrent(plan);
  const psbt=bitcoin.Psbt.fromHex(plan.psbtHex,{network:NET}), signer=signerFor(wallet.addresses[plan.addressType],plan.addressType);
  psbt.data.inputs.forEach((input,i)=>{ if(input.partialSig?.length||input.tapKeySig||input.tapScriptSig?.length) throw new Error("PSBT already contains signatures."); psbt.signInput(i,signer,plan.addressType==="taproot"?[bitcoin.Transaction.SIGHASH_DEFAULT,bitcoin.Transaction.SIGHASH_ALL]:[bitcoin.Transaction.SIGHASH_ALL]); });
  const verify=plan.addressType==="taproot"?(key:Uint8Array,h:Uint8Array,s:Uint8Array)=>ecc.verifySchnorr(h,key,s):(key:Uint8Array,h:Uint8Array,s:Uint8Array)=>ecc.verify(h,key,s);
  try { psbt.validateSignaturesOfAllInputs(verify); psbt.finalizeAllInputs(); } catch { throw new Error("Local Rune PSBT signature validation failed."); }
  const rawTxHex=psbt.extractTransaction(true).toHex(), tx=validateTx(rawTxHex,plan);
  return {rawTxHex,txid:tx.getId().toLowerCase()};
}
export async function broadcastLocalRuneTransfer(plan: LocalRuneTransferPlan,wallet:OrdiWalletRecord,signed:{rawTxHex:string;txid:string}) {
  if(wallet.addresses[plan.addressType]?.address!==plan.sourceAddress) throw new Error("Local source account changed.");
  await assertCurrent(plan);
  const tx=validateTx(signed.rawTxHex,plan);
  if(tx.getId().toLowerCase()!==signed.txid.toLowerCase()) throw new Error("TXID does not match reviewed transaction.");
  const config=getMempoolConfig(plan.network); if(!config) throw new Error("Network is not configured.");
  const response=await fetch(`${config.api}/api/tx`,{method:"POST",headers:{"Content-Type":"text/plain"},body:signed.rawTxHex});
  const returned=(await response.text()).replace(/^"|"$/g,"").toLowerCase();
  if(!response.ok||returned!==signed.txid.toLowerCase()) throw new Error(`Broadcast uncertain; verify TXID ${signed.txid} before retrying.`);
  return signed.txid;
}
