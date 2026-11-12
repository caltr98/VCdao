// Verified against Polymarket's published contracts on 2026-09-26; V2 CTF markets only.
// No imports: the hosted Worker bundles this file without the parent project's ethers copy.
export const POLYGON = {
  chainId: 137n,
  collateral: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  positions: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  exchange: "0xE111180000d2663C0091e4f400237545B87B996B",
  negRiskExchange: "0xe2222d279d744050d28e00520010520000310F59",
};

// Current standard-market adapter, read back on Polygon on 2026-10-02.
export const COLLATERAL_ADAPTER = "0xAdA100Db00Ca00073811820692005400218FcE1f";

export function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
