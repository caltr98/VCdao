import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import { POLYGON } from "./addresses";

// Read-only preparation. This script never broadcasts or writes credentials.
async function main() {
  const journal = JSON.parse(readFileSync("output/live-auction-1.json", "utf8"));
  const [signer] = await ethers.getSigners();
  if (signer.address.toLowerCase() !== journal.member.toLowerCase()) throw new Error("Wrong governance signer");
  const vault = await ethers.getContractAt("OrderVault", journal.dao.vault);
  const governor = await ethers.getContractAt("MarketGovernor", journal.dao.governor);
  const recipient = "0x7a46dCFfa7064Fe54Ee848b125a5C58c3b9f5Ddb";
  const targets = [journal.dao.vault], values = [0];
  const calldatas = [vault.interface.encodeFunctionData("withdrawCollateral", [recipient, 2_000_000n])];
  const description = "Recover first open-auction run: return 2 pUSD to the funding Safe";
  const topic = BigInt(journal.market.conditionId);
  // eth_call exercises the deployed Governor's validation without creating a proposal.
  const proposal = await governor.proposeWithTopic.staticCall(targets, values, calldatas, description, topic);
  const collateral = new ethers.Contract(POLYGON.collateral, ["function balanceOf(address) view returns(uint256)"], ethers.provider);
  const report = { chainId: (await ethers.provider.getNetwork()).chainId.toString(), signer: signer.address,
    vault: journal.dao.vault, governor: journal.dao.governor, recipient, amount: "2000000",
    status: (await vault.status(journal.authorizeBuy.id)).toString(), reserved: (await vault.reserved()).toString(),
    vaultBalance: (await collateral.balanceOf(journal.dao.vault)).toString(),
    recipientBalance: (await collateral.balanceOf(recipient)).toString(),
    expireCalldata: vault.interface.encodeFunctionData("expire", [journal.authorizeBuy.id]),
    targets, values, calldatas, description, descriptionHash: ethers.id(description), topic: topic.toString(),
    proposal: proposal.toString(), deployedGovernorAccepted: true, liveTransactions: 0 };
  if (report.chainId !== "137") throw new Error("Expected Polygon");
  writeFileSync("output/auction-recovery-prepared.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}

main().catch(() => { console.error("Recovery preparation failed; no transactions sent. Credentials and RPC details suppressed."); process.exitCode = 1; });
