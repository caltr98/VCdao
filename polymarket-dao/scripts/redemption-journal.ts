import { ethers } from "hardhat";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Provider, Signer, TransactionRequest, TransactionResponse, TypedDataDomain, TypedDataField } from "ethers";

type Entry = { request: string; hash: string; raw?: string; gasLimit: string; worstCaseFee: string; receipt?: { block: number; gasUsed: string; gasPrice: string; fee: string; status: number | null } };
export type RedemptionJournal = { transactions: Record<string, Entry>; snapshots: Record<string, unknown>; completed?: boolean; result?: unknown; planHash: string };
export const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n";

export function openJournal(path: string, planHash: string) {
  const state: RedemptionJournal = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { planHash, transactions: {}, snapshots: {} };
  if (state.planHash !== planHash) throw new Error("Journal belongs to another approved plan");
  const save = () => { writeFileSync(path + ".tmp", json(state)); renameSync(path + ".tmp", path); };
  return { state, save };
}

/// Factories and governance calls share this signer, including deployments. A resumed label must
/// match its original request; live signed bytes are persisted before broadcasting them.
export class RedemptionSigner extends ethers.AbstractSigner {
  private sequence = 0;
  private label?: string;

  constructor(private signer: Signer, readonly state: RedemptionJournal, private save: () => void, private live: boolean, private feeCap: bigint, private gasBudget: bigint, private fixedForkGasPrice?: bigint) {
    super(signer.provider!);
  }

  getAddress() { return this.signer.getAddress(); }
  signTransaction(request: TransactionRequest) { return this.signer.signTransaction(request); }
  signMessage(message: string | Uint8Array) { return this.signer.signMessage(message); }
  signTypedData(domain: TypedDataDomain, types: Record<string, TypedDataField[]>, value: Record<string, unknown>) { return this.signer.signTypedData(domain, types, value); }
  connect(provider: Provider) { return new RedemptionSigner(this.signer.connect(provider), this.state, this.save, this.live, this.feeCap, this.gasBudget, this.fixedForkGasPrice); }

  async named<T>(label: string, action: () => Promise<T>) {
    this.label = label;
    try { return await action(); } finally { this.label = undefined; }
  }

  async snapshot<T>(name: string, read: () => Promise<T>): Promise<T> {
    if (this.state.snapshots[name] === undefined) { this.state.snapshots[name] = await read(); this.save(); }
    return this.state.snapshots[name] as T;
  }

  async sendTransaction(request: TransactionRequest): Promise<TransactionResponse> {
    const label = this.label ?? `deployment-${String(++this.sequence).padStart(3, "0")}`;
    const fingerprint = json({ to: request.to ? await ethers.resolveAddress(request.to, this.provider!) : null, data: request.data ?? "0x", value: request.value ?? 0 });
    const previous = this.state.transactions[label];
    if (previous && previous.request !== fingerprint) throw new Error(`${label}: request changed; preserve and inspect the journal`);
    if (!previous) await this.prepare(label, fingerprint, request);
    return this.confirm(label);
  }

  private async prepare(label: string, fingerprint: string, request: TransactionRequest) {
    const gasLimit = await this.signer.estimateGas(request) * 12n / 10n + 20_000n;
    const spent = Object.values(this.state.transactions).reduce((sum, entry) => sum + BigInt(entry.receipt?.fee ?? entry.worstCaseFee), 0n);
    if (spent + gasLimit * this.feeCap > this.gasBudget) throw new Error("Approved total network gas budget exhausted");
    const fees = await this.provider!.getFeeData();
    if ((fees.gasPrice ?? 0n) > this.feeCap || (fees.maxPriorityFeePerGas ?? 0n) > this.feeCap) throw new Error("Network fees exceed the approved gas-price cap");
    const envelope = !this.live && this.fixedForkGasPrice ? { type: 0, gasPrice: this.fixedForkGasPrice } : { type: 2, maxFeePerGas: this.feeCap, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n };
    const populated = await this.signer.populateTransaction({ ...request, chainId: 137, gasLimit, ...envelope });
    if (this.live) {
      const raw = await this.signer.signTransaction(populated);
      this.state.transactions[label] = { request: fingerprint, raw, hash: ethers.keccak256(raw), gasLimit: String(gasLimit), worstCaseFee: String(gasLimit * this.feeCap) };
      try { this.save(); }
      catch (error) { delete this.state.transactions[label]; throw error; }
    } else {
      const tx = await this.signer.sendTransaction(populated);
      this.state.transactions[label] = { request: fingerprint, hash: tx.hash, gasLimit: String(gasLimit), worstCaseFee: String(gasLimit * this.feeCap) };
      this.save();
    }
  }

  private async confirm(label: string) {
    const entry = this.state.transactions[label];
    const alreadyConfirmed = Boolean(entry.receipt);
    let tx = await this.provider!.getTransaction(entry.hash);
    if (!tx) {
      if (!entry.raw) throw new Error(`${label}: fork transaction unavailable`);
      // Resume by broadcasting the same signed nonce and bytes; never create a replacement.
      tx = await this.provider!.broadcastTransaction(entry.raw);
    }
    const receipt = await tx.wait(1, 60_000).catch(async error => {
      const mined = await this.provider!.getTransactionReceipt(entry.hash);
      if (!mined) throw error;
      return mined;
    });
    if (!receipt) throw new Error(`${label}: confirmation timeout; resume from this journal`);
    entry.receipt = { block: receipt.blockNumber, status: receipt.status, gasUsed: String(receipt.gasUsed), gasPrice: String(receipt.gasPrice), fee: String(receipt.fee) };
    this.save();
    if (receipt.status !== 1) throw new Error(`${label}: reverted; inspect the journal before continuing`);
    if (!alreadyConfirmed) console.log(`${label}: confirmed ${tx.hash}`);
    return tx;
  }
}
