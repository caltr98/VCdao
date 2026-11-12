import type { PolymarketOrder } from "../typechain-types/contracts/OrderWallet";

// Ethers returns a readonly tuple; transports need named fields, not numeric keys.
export function orderObject(order: PolymarketOrder.OrderStructOutput) {
  const { salt, maker, signer, tokenId, makerAmount, takerAmount, side, signatureType, timestamp, metadata, builder, signature } = order;
  return { salt, maker, signer, tokenId, makerAmount, takerAmount, side, signatureType, timestamp, metadata, builder, signature };
}

export type OrderFields = ReturnType<typeof orderObject>;
