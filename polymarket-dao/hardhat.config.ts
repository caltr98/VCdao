import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

// The live Polygon network exists only when both variables are set in the shell (see scripts/deploy.ts).
const { POLYGON_RPC_URL, DEPLOYER_PRIVATE_KEY } = process.env;

const config: HardhatUserConfig = {
  gasReporter: { enabled: false },
  solidity: {
    version: "0.8.28",
    settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 } },
  },
  networks: POLYGON_RPC_URL && DEPLOYER_PRIVATE_KEY ? { polygon: { url: POLYGON_RPC_URL, accounts: [DEPLOYER_PRIVATE_KEY], chainId: 137 } } : {},
};

export default config;
