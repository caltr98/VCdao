import { getAddress, ZeroAddress } from "ethers";

/// Failures written by this service. Only these messages reach the public status report;
/// other errors can quote configuration text or RPC URLs, so they are reported by code only.
export class CheckFailure extends Error {}

export type Issue = { stage: string; item?: string; code: string; reason?: string };

// Contract revert reasons are public data; provider messages are not reported.
export function describeError(error: unknown): { code: string; reason?: string } {
  if (error instanceof CheckFailure) return { code: "CHECK_FAILED", reason: error.message };
  const value = error as { code?: unknown; reason?: unknown; revert?: { name?: string } } | null;
  const reason = value?.code === "CALL_EXCEPTION" ? String(value.reason ?? value.revert?.name ?? "") : "";
  return { code: typeof value?.code === "string" ? value.code : "UNEXPECTED_ERROR", reason: reason || undefined };
}

export type DaoConfig = { governor: string; vault: string; automation: string; startBlock: number; confirmations: number };

export function parseConfig(json: string): DaoConfig | undefined {
  if (!json.trim()) return undefined;
  const value = parseJson(json, "DAO_CONFIG");
  const addresses = ["governor", "vault", "automation"].map(key => getAddress(value[key]));
  if (addresses.includes(ZeroAddress)) throw new CheckFailure("Deployment addresses must be nonzero");
  if (!Number.isSafeInteger(value.startBlock) || value.startBlock < 1) throw new CheckFailure("Expected deployment startBlock");
  const confirmations = value.confirmations ?? 32;
  if (!Number.isSafeInteger(confirmations) || confirmations < 32) throw new CheckFailure("At least 32 confirmations required");
  return { governor: addresses[0], vault: addresses[1], automation: addresses[2], startBlock: value.startBlock, confirmations };
}

// JSON.parse errors quote the input, which may be a secret.
export function parseJson(json: string, name: string): any {
  try { return JSON.parse(json); } catch { throw new CheckFailure(`${name} is not valid JSON`); }
}

export type WorkerVariables = {
  DAO_CONFIG: string; EXECUTION_ENABLED: string; ORDER_SUBMISSION_ENABLED: string; MAX_TOTAL_GAS_WEI: string;
  GAS_PRIVATE_KEY?: string; CLOB_CREDENTIALS?: string;
};

/// Switches are on only for the exact string "true". CLOB credentials are parsed by the
/// transport stage, so a credential mistake cannot stop cleanup.
export type Settings = {
  config?: DaoConfig; execution: boolean; submission: boolean; gasCapWei: bigint;
  gasKey?: string; clobCredentials?: string;
};

export function parseSettings(vars: WorkerVariables): Settings {
  const execution = vars.EXECUTION_ENABLED === "true";
  if (execution && !vars.GAS_PRIVATE_KEY) throw new CheckFailure("Missing gas signer");
  if (!/^\d+$/.test(vars.MAX_TOTAL_GAS_WEI)) throw new CheckFailure("MAX_TOTAL_GAS_WEI must be an integer wei amount");
  const submission = vars.ORDER_SUBMISSION_ENABLED === "true";
  return { config: parseConfig(vars.DAO_CONFIG), execution, submission, gasCapWei: BigInt(vars.MAX_TOTAL_GAS_WEI), gasKey: vars.GAS_PRIVATE_KEY || undefined, clobCredentials: vars.CLOB_CREDENTIALS || undefined };
}

export type Credentials = { address: string; key: string; secret: string; passphrase: string };

export type Proposal = { id: string; targets: string[]; values: string[]; calldatas: string[]; descriptionHash: string };

/// One signed version of the pending nonce. Fee replacements add versions; at most one can be mined.
export type TransactionVersion = { hash: string; raw: string; maxFeePerGas: string; maxPriorityFeePerGas: string; sentBlock: number };
/// `reservedWei` is the largest cost any version can reach; `keepWei` is the cleanup reserve a
/// repricing must leave. `refused` holds the RPC's code for the latest refused broadcast and
/// `blocked` says why repricing stopped; either one means the signer is stalled.
export type PendingTransaction = {
  label: string; from: string; to: string; data: string; nonce: number; gasLimit: string;
  reservedWei: string; keepWei: string; versions: TransactionVersion[];
  refused?: string; blocked?: string;
};

/// `venue` is the CLOB's own record of the order; `settlement` is the exchange's onchain fill status.
export type OrderAttempt = {
  digest: string; wallet: string; exchange: string;
  status: "posting" | "accepted" | "rejected" | "unknown"; attemptedAt: string;
  httpStatus?: number; code?: string; message?: string;
  venue?: { status: string; sizeMatched?: string; originalSize?: string; checkedAt: string };
  settlement?: { filled: boolean; remaining: string; checkedAt: string };
};

/// `spentWei` counts confirmed receipts; the pending transaction reserves its worst-case cost.
/// `reverts` counts mined failures per action label.
export type RunnerState = {
  cursor?: { number: number; hash: string };
  proposals: Proposal[];
  wallets: string[];
  pending?: PendingTransaction;
  spentWei: string;
  reverts: Record<string, number>;
  attempts: Record<string, OrderAttempt>;
  notices: string[];
};

export function emptyState(): RunnerState {
  return { proposals: [], wallets: [], spentWei: "0", reverts: {}, attempts: {}, notices: [] };
}

// Keep the latest operational notices only; the report is public and should stay small.
export function notice(state: RunnerState, text: string) {
  state.notices = [...state.notices, `${new Date().toISOString()} ${text}`].slice(-20);
}

export interface Journal {
  save(state: RunnerState): Promise<void>;
}
