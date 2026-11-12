import { ethers } from "hardhat";
import { impersonateAccount, mine, setBalance, time } from "@nomicfoundation/hardhat-network-helpers";
import { strict as assert } from "assert";
import { writeFileSync } from "fs";
import type { JsonRpcProvider, Log, LogDescription } from "ethers";
import { forkPolygon } from "./fork";
import { POLYGON } from "./addresses";
import { deployDao } from "./deployment";
import { issueSkill, proposal, approveAndExecute } from "./local";

// Open-auction push delivery from the live solver Deposit Wallet.
// The wallet and holders are impersonated; this checks Polygon token behavior,
// not relayer admission or a CLOB trade. No session signer is used.
const walletAddress = "0x92DC8012d9C27703d9EBE7a3EdD1037eE8ac4f2a";
const positionsAbi = ["function balanceOf(address,uint256) view returns(uint256)", "function setApprovalForAll(address,bool)",
  "function safeTransferFrom(address,address,uint256,uint256,bytes)"];
const erc20Abi = ["function balanceOf(address) view returns(uint256)", "function transfer(address,uint256) returns(bool)"];

async function impersonated(address: string) {
  await impersonateAccount(address);
  await setBalance(address, ethers.parseEther("10"));
  return ethers.getSigner(address);
}

// An EOA that recently received an outcome token and still holds at least one share.
async function findShareholder(remote: JsonRpcProvider, block: number) {
  const positions = new ethers.Contract(POLYGON.positions, positionsAbi, ethers.provider);
  const logs = await remote.getLogs({ address: POLYGON.positions, topics: [ethers.id("TransferSingle(address,address,address,uint256,uint256)")], fromBlock: block - 50, toBlock: block });
  for (const log of logs) {
    const holder = ethers.getAddress(ethers.dataSlice(log.topics[3], 12));
    const [tokenId] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256"], log.data);
    if ((await ethers.provider.getCode(holder)) !== "0x") continue;
    const balance: bigint = await positions.balanceOf(holder, tokenId);
    if (balance >= 2_000_000n) return { holder, tokenId: tokenId as bigint, shares: 2_000_000n };
  }
  throw new Error("No EOA shareholder in the recent blocks");
}

async function findCollateralHolder(remote: JsonRpcProvider, block: number, amount: bigint) {
  const collateral = new ethers.Contract(POLYGON.collateral, erc20Abi, ethers.provider);
  const logs = await remote.getLogs({ address: POLYGON.collateral, topics: [ethers.id("Transfer(address,address,uint256)")], fromBlock: block - 200, toBlock: block });
  for (const log of logs) {
    const to = ethers.getAddress(ethers.dataSlice(log.topics[2], 12));
    if (![POLYGON.exchange, POLYGON.negRiskExchange, POLYGON.collateral].some(a => a.toLowerCase() === to.toLowerCase()) && await collateral.balanceOf(to) >= amount) return to;
  }
  throw new Error("No recent pUSD holder");
}

async function main() {
  const fork = await forkPolygon();
  try {
    const [deployer, alice, bob, issuer] = await ethers.getSigners();
    const share = await findShareholder(fork.remote, fork.block);
    const payment = share.shares / 2n;
    const topic = BigInt(ethers.id("fork-delivery-session"));
    const closesAt = new Date((fork.timestamp + 30 * 86_400) * 1000).toISOString();
    // The registry does not read the CTF, so the observed token stands in as the YES outcome.
    const plan = { timelockDelaySeconds: 1, votingDelayBlocks: 1, votingPeriodBlocks: 30, skillWeightBps: 5000, trustedIssuer: issuer.address,
      markets: [{ conditionId: ethers.toBeHex(topic, 32), yesToken: share.tokenId.toString(), noToken: (share.tokenId + 1n).toString(), skillTopic: 2, closesAt, uri: "fork" }] };
    const dao = await deployDao(plan, POLYGON, deployer);
    const vaultAddress = await dao.vault.getAddress();
    const collateral = new ethers.Contract(POLYGON.collateral, erc20Abi, ethers.provider);
    const positions = new ethers.Contract(POLYGON.positions, positionsAbi, ethers.provider);
    const holder = await impersonated(await findCollateralHolder(fork.remote, fork.block, payment));
    await (await collateral.connect(holder).getFunction("transfer")(vaultAddress, payment)).wait();
    for (const member of [alice, bob]) {
      await (await dao.token.connect(member).joinDAO({ value: ethers.parseEther("20") })).wait();
      await (await dao.token.connect(member).delegate(member.address)).wait();
    }
    await issueSkill(dao.skills, issuer, alice, ["blockchain"]);
    await mine();

    // The executor acquires the shares off-DAO; here a holder sends them to the executor's wallet.
    const seller = await impersonated(share.holder);
    await (await positions.connect(seller).getFunction("safeTransferFrom")(seller.address, walletAddress, share.tokenId, share.shares, "0x")).wait();

    const id = ethers.id("fork-delivery-session:1");
    const deadline = (await time.latest()) + 7200;
    const buy = { market: topic, tokenId: share.tokenId, shares: share.shares, payment, deadline, executor: ethers.ZeroAddress };
    const action = await proposal(dao.governor, alice, vaultAddress, dao.vault.interface.encodeFunctionData("authorizeBuy", [id, buy]), topic, "Fork: buy via Deposit Wallet delivery");
    await approveAndExecute(dao.governor, [alice, bob], action);
    assert.equal(await dao.vault.status(id), 1n);

    const solver = await impersonated(walletAddress);
    const auditData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32"], [id, ethers.id("settlement-tx"), ethers.id("order")]);
    async function run(amount: bigint) {
      return (await positions.connect(solver).getFunction("safeTransferFrom")(
        walletAddress, vaultAddress, share.tokenId, amount, auditData)).wait();
    }
    async function rejects(amount: bigint, reason: string) {
      await assert.rejects(run(amount), error => String(error).includes(reason));
    }
    await rejects(share.shares - 1n, "Wrong delivery");
    await time.increaseTo(deadline - 3600);
    const expectedPayment = await dao.vault.currentPayment(id);
    assert.ok(expectedPayment > 0n && expectedPayment < payment);
    const before = { wallet: await collateral.balanceOf(walletAddress), vaultShares: await positions.balanceOf(vaultAddress, share.tokenId) };
    const receipt = await run(share.shares);
    const after = { wallet: await collateral.balanceOf(walletAddress), vaultShares: await positions.balanceOf(vaultAddress, share.tokenId) };
    const delivered = receipt!.logs.map((log: Log) => {
      try { return dao.vault.interface.parseLog(log); } catch { return null; }
    }).find((log: LogDescription | null) => log?.name === "PositionDelivered");
    const paid = delivered!.args.payment as bigint;
    assert.equal(after.wallet - before.wallet, paid);
    assert.ok(paid >= expectedPayment && paid < payment);
    assert.equal(after.vaultShares - before.vaultShares, share.shares);
    assert.equal(await dao.vault.status(id), 2n);
    // Replenish the wallet so replay reaches the vault check rather than failing for balance.
    await (await positions.connect(await impersonated(vaultAddress)).getFunction("safeTransferFrom")(
      vaultAddress, walletAddress, share.tokenId, share.shares, "0x")).wait();
    await rejects(share.shares, "Not authorized");
    await (await collateral.connect(holder).getFunction("transfer")(vaultAddress, paid)).wait();
    const expiredId = ethers.id("fork-auction-push:expired");
    const expiredBuy = { ...buy, deadline: (await time.latest()) + 3600 };
    const expiredAction = await proposal(dao.governor, alice, vaultAddress,
      dao.vault.interface.encodeFunctionData("authorizeBuy", [expiredId, expiredBuy]), topic, "Fork: expired push");
    await approveAndExecute(dao.governor, [alice, bob], expiredAction);
    await time.increaseTo(expiredBuy.deadline + 1);
    const expiredData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32"], [expiredId, ethers.id("expired-tx"), ethers.id("expired-order")]);
    await assert.rejects(positions.connect(solver).getFunction("safeTransferFrom")(
      walletAddress, vaultAddress, share.tokenId, share.shares, expiredData),
      error => String(error).includes("Execution expired"));
    const report = { block: fork.block, wallet: walletAddress, vault: vaultAddress,
      tokenId: share.tokenId.toString(), shares: share.shares.toString(), payment: paid.toString(),
      governanceExecuted: true, pushFulfilled: receipt!.status === 1, paidOnDelivery: true,
      wrongAmountRejected: true, secondPushRejected: true, expiredPushRejected: true,
      limits: "wallet and holders impersonated; no relayer and no CLOB; no session key",
      liveTransactions: 0 };
    writeFileSync("output/fork-delivery-session.json", JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally { fork.remote.destroy(); }
}

main().catch(error => {
  console.error(error.code === "ERR_ASSERTION" ? error.message : String(error.shortMessage ?? error.message).replace(/https?:\/\/\S+/g, "[RPC redacted]"));
  process.exitCode = 1;
});


