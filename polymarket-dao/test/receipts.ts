import { expect } from "chai";
import { Interface, id, ZeroHash } from "ethers";
import { POLYGON, exchangeAbi, assetAbi, verifyPurchaseLogs, Purchase } from "../scripts/polymarket";

describe("Polymarket receipt evidence", function () {
  const executor = "0x1111111111111111111111111111111111111111";
  const seller = "0x2222222222222222222222222222222222222222";
  const orderHash = id("order");
  const purchase: Purchase = { executor, orderHash, tokenId: 11n, shares: 100_000_000n, payment: 55_000_000n };

  function log(address: string, abi: Interface, event: string, args: unknown[]) {
    return { address, ...abi.encodeEventLog(abi.getEvent(event)!, args) };
  }

  function evidence() {
    return [
      log(POLYGON.exchange, exchangeAbi, "OrderFilled", [orderHash, executor, seller, 0, 11, 54_000_000, 100_000_000, 0, ZeroHash, ZeroHash]),
      log(POLYGON.collateral, assetAbi, "Transfer", [executor, seller, 54_000_000]),
      log(POLYGON.positions, assetAbi, "TransferSingle", [POLYGON.exchange, seller, executor, 11, 100_000_000]),
    ];
  }

  it("verifies exchange, order, wallet, outcome, shares and collateral movement", function () {
    expect(verifyPurchaseLogs(evidence(), purchase)).to.deep.equal({ sharesReceived: "100000000", collateralSpent: "54000000", fillCount: 1 });
  });

  it("rejects a forged event from another contract", function () {
    const logs = evidence();
    logs[0].address = seller;
    expect(() => verifyPurchaseLogs(logs, purchase)).to.throw("No matching");
  });

  it("rejects another order, wallet, outcome or the sell side", function () {
    for (const change of [{ orderHash: id("wrong") }, { executor: seller }, { tokenId: 12n }]) {
      expect(() => verifyPurchaseLogs(evidence(), { ...purchase, ...change })).to.throw();
    }
    const logs = evidence();
    logs[0] = log(POLYGON.exchange, exchangeAbi, "OrderFilled", [orderHash, executor, seller, 1, 11, 100_000_000, 54_000_000, 0, ZeroHash, ZeroHash]);
    expect(() => verifyPurchaseLogs(logs, purchase)).to.throw("wrong buyer, side or outcome");
  });

  it("rejects fill events without actual asset delivery", function () {
    expect(() => verifyPurchaseLogs(evidence().slice(0, 2), purchase)).to.throw("Settlement balances");
  });

  it("accounts for outgoing outcome transfers and collateral fees", function () {
    const outgoing = log(POLYGON.positions, assetAbi, "TransferSingle", [POLYGON.exchange, executor, seller, 11, 1]);
    expect(() => verifyPurchaseLogs([...evidence(), outgoing], purchase)).to.throw("Settlement balances");
    const fee = log(POLYGON.collateral, assetAbi, "Transfer", [executor, seller, 2_000_000]);
    expect(() => verifyPurchaseLogs([...evidence(), fee], purchase)).to.throw("Settlement balances");
  });

  it("supports ERC1155 batch transfers without counting unrelated outcomes", function () {
    const logs = evidence().slice(0, 2);
    logs.push(log(POLYGON.positions, assetAbi, "TransferBatch", [POLYGON.exchange, seller, executor, [12, 11], [900_000_000, 100_000_000]]));
    expect(verifyPurchaseLogs(logs, purchase).sharesReceived).to.equal("100000000");
  });

  it("requires the selected order itself to have filled the approved shares", function () {
    const logs = evidence();
    logs[0] = log(POLYGON.exchange, exchangeAbi, "OrderFilled", [orderHash, executor, seller, 0, 11, 1, 1, 0, ZeroHash, ZeroHash]);
    expect(() => verifyPurchaseLogs(logs, purchase)).to.throw("Order fill amounts");
  });
});
