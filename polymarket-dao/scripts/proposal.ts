import { readFileSync } from "node:fs";
import { AbiCoder, Interface, getAddress, id, isHexString, keccak256, parseUnits } from "ethers";
import vaultArtifact from "../artifacts/contracts/OrderVault.sol/OrderVault.json";
import governorArtifact from "../artifacts/contracts/MarketGovernor.sol/MarketGovernor.json";
import automationArtifact from "../artifacts/contracts/GovernanceAutomation.sol/GovernanceAutomation.json";
import { printJson } from "./polymarket";

function main() {
  if (!process.argv[2]) throw new Error("Usage: npm run proposal -- examples/buy.json");
  const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
  if (!isHexString(request.conditionId, 32) || !request.description) throw new Error("Condition ID and description are required");
  const vault = getAddress(request.vault), governor = getAddress(request.governor);
  const mode = request.mode ?? "delivery";
  if (!["contract", "delivery"].includes(mode) || !request.intent) throw new Error("Expected contract/delivery mode and a unique intent name");
  const common = {
    market: BigInt(request.conditionId), tokenId: BigInt(request.tokenId),
    shares: parseUnits(request.shares, 6), deadline: Math.floor(Date.parse(request.deadline) / 1000),
  };
  const terms = mode === "contract"
    ? { principal: parseUnits(request.principal, 6), feeBudget: parseUnits(request.feeBudget, 6), exchange: getAddress(request.exchange) }
    : { payment: parseUnits(request.payment, 6), executor: getAddress(request.executor) };
  const buy = { ...common, ...terms };
  const principal = terms.principal ?? terms.payment!;
  const budget = principal + (terms.feeBudget ?? 0n);
  if (buy.shares <= 0n || principal <= 0n || (terms.feeBudget ?? 0n) < 0n || budget >= buy.shares) throw new Error("Expected positive quantities and a total budget below one pUSD per share");
  // The Worker posts FOK orders shaped like the official SDK's: principal and shares in hundredths.
  if (mode === "contract" && (buy.shares % 10_000n !== 0n || principal % 10_000n !== 0n)) throw new Error("Contract orders need principal and shares with at most two decimals");
  if (!Number.isSafeInteger(buy.deadline) || buy.deadline <= Date.now() / 1000) throw new Error("Deadline must be in the future");
  const intentId = id(request.intent);
  const action = new Interface(vaultArtifact.abi).encodeFunctionData(mode === "contract" ? "authorizeOrder" : "authorizeBuy", [intentId, buy]);
  const governorInterface = new Interface(governorArtifact.abi);
  const args = [[vault], [0], [action], id(request.description)];
  const proposalId = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(["address[]", "uint256[]", "bytes[]", "bytes32"], args)));
  const automation = request.automation ? { target: getAddress(request.automation), checkerData: new Interface(automationArtifact.abi).encodeFunctionData("checker", args), advanceData: new Interface(automationArtifact.abi).encodeFunctionData("advance", args) } : undefined;
  printJson({ mode, intentId, proposalId, buy, automation, calls: {
    propose: call(governorInterface.encodeFunctionData("proposeWithTopic", [[vault], [0], [action], request.description, buy.market])),
    voteFor: call(governorInterface.encodeFunctionData("castVote", [proposalId, 1])),
    voteAgainst: call(governorInterface.encodeFunctionData("castVote", [proposalId, 0])),
    queue: call(governorInterface.encodeFunctionData("queue", args)),
    execute: call(governorInterface.encodeFunctionData("execute", args)),
  }, note: "Unsigned calldata. Submit each call separately when its governance stage is available. Addresses in the example are placeholders." });

  function call(data: string) { return { to: governor, value: "0", data }; }
}

try { main(); } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
