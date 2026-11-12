import { expect } from "chai";
import { ethers } from "hardhat";

// Unit check of SafeTraderGuard's allow-list; the Safe integration runs in `npm run check:fork-safe`.
describe("SafeTraderGuard", () => {
  const erc20 = new ethers.Interface(["function approve(address,uint256)", "function transfer(address,uint256)"]);

  async function deploy() {
    const [, collateral, exchange, other] = await ethers.getSigners();
    const guard = await (await ethers.getContractFactory("SafeTraderGuard")).deploy(collateral.address, exchange.address);
    const check = (to: string, data: string, value = 0n, operation = 0) =>
      guard.checkTransaction(to, value, data, operation, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, "0x", other.address);
    return { guard, check, collateral: collateral.address, exchange: exchange.address, other: other.address };
  }

  it("allows only collateral approvals to the exchange", async () => {
    const { check, collateral, exchange } = await deploy();
    await check(collateral, erc20.encodeFunctionData("approve", [exchange, ethers.MaxUint256]));
    await check(collateral, erc20.encodeFunctionData("approve", [exchange, 0]));
  });

  it("rejects transfers, other spenders, other targets, value and delegatecall", async () => {
    const { guard, check, collateral, exchange, other } = await deploy();
    const approve = erc20.encodeFunctionData("approve", [exchange, 1]);
    for (const call of [
      check(collateral, erc20.encodeFunctionData("transfer", [other, 1])),
      check(collateral, erc20.encodeFunctionData("approve", [other, 1])),
      check(other, approve),
      check(collateral, approve, 1n),
      check(collateral, approve, 0n, 1),
      check(collateral, approve + "00"),
    ]) await expect(call).to.be.revertedWithCustomError(guard, "OwnerTransactionNotAllowed");
  });

  it("declares the Safe guard interface", async () => {
    const { guard } = await deploy();
    expect(await guard.supportsInterface("0xe6d7a83a")).to.equal(true);
  });
});
