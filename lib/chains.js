// The chain address books, in one place.
//
// These addresses were re-typed as `const` literals in 22-29 scripts each
// (MARKET_VIEW and MARKET_FACTORY in 27, SUSDS in 24, POSITION_MANAGER in 22).
// Every entry here is cross-checked against lifecycle/*.json by
// tests/chains.test.js, so this file and the manifests cannot drift apart.
//
// A campaign should prefer its manifest's `addresses` block; this is the
// fallback and the thing the manifests are validated against.

import { ethers } from "ethers";

// MARKET_VIEW is lowercase in all 27 script copies while everything else is
// checksummed. Normalising on load means a checksum comparison can never
// surprise anyone again.
const addr = (a) => ethers.getAddress(a);

export const CHAINS = {
  10: {
    id: 10,
    name: "optimism",
    rpcEnv: "RPC_URL",
    collateral: { symbol: "sUSDS", address: addr("0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0"), decimals: 18 },
    amm: { kind: "uniswap-v3", feeTier: 100, tickSpacing: 1 },
    addresses: {
      marketFactory: addr("0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6"),
      marketView: addr("0x336695ec9efbafd6322fb82eaadbcda02e38f348"),
      router: addr("0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD"),
      positionManager: addr("0xC36442b4a4522E871399CD717aBDD847Ab11FE88"),
      poolFactory: addr("0x1F98431c8aD98523631AE4a59f267346ea31F984"),
      realitio: addr("0x0eF940F7f053a2eF5D6578841072488aF0c7d89A"),
      arbitrator: addr("0x5AFa42b30955f137e10f89dfb5EF1542a186F90e"),
    },
  },
  100: {
    id: 100,
    name: "gnosis",
    rpcEnv: "GNOSIS_RPC_URL",
    collateral: { symbol: "sDAI", address: addr("0xaf204776c7245bF4147c2612BF6e5972Ee483701"), decimals: 18 },
    // Algebra has ONE dynamic fee and no tiers, so there is no feeTier to send.
    // mathFeeTier exists purely so @uniswap/v3-sdk derives tickSpacing 60 for
    // the position math; it is never sent on chain.
    amm: { kind: "algebra-v1", tickSpacing: 60, mathFeeTier: 3000 },
    addresses: {
      marketFactory: addr("0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1"),
      marketView: addr("0x95493F3e3F151eD9ee9338a4Fc1f49c00890F59C"),
      // Gnosis uses the Seer GnosisRouter, not the Optimism Router.
      router: addr("0xeC9048b59b3467415b1a38F63416407eA0c70fB8"),
      // The Swapr Algebra NPM. Its positions() returns ELEVEN values, not
      // twelve — there is no `fee` field, because Algebra has no fee tiers.
      positionManager: addr("0x91fD594c46D8B01E62dBDeBed2401dde01817834"),
      // Algebra PoolDeployer, used for CREATE2 pool-address derivation.
      poolFactory: addr("0xC1b576AC6Ec749d5Ace1787bF9Ec6340908ddB47"),
    },
  },
};

/** Algebra pool init code hash, for CREATE2 address derivation on Gnosis. */
export const ALGEBRA_INIT_CODE_HASH = "0xbce37a54eab2fcd71913a0d40723e04238970e7fc1159bfd58ad5b79531697e7";

export function chain(id) {
  const c = CHAINS[Number(id)];
  if (!c) throw new Error(`unknown chain ${id}; known: ${Object.keys(CHAINS).join(", ")}`);
  return c;
}

export function addressesFor(id) {
  return chain(id).addresses;
}

export function ammFor(id) {
  return chain(id).amm;
}
