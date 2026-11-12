import config from "./hardhat.config";

export default { ...config, networks: { hardhat: { chainId: 137 } } };
