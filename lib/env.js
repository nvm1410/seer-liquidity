// Environment and provider setup, with both guards that the two newest script
// lineages have only one each of.
//
//   add-originality-r3-liquidity.js  checks env vars are present, but NOT the chain
//   add-zcash-nu7-liquidity.js       checks the chain id, but NOT the env vars
//
// Missing PRIVATE_KEY in the second shape throws from inside
// `new ethers.Wallet(undefined, ...)` at module load, which is a confusing place
// to learn you have no .env. A stale RPC_URL in the first shape gets past every
// check and fails at the first contract call, after the wallet already exists.

import "dotenv/config";
import { ethers } from "ethers";
import { chain } from "./chains.js";

/** Throw unless every named env var is set and non-empty. */
export function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(
      `missing required env var(s): ${missing.join(", ")}. ` +
        "Copy .env.example to .env and fill them in."
    );
  }
  return Object.fromEntries(names.map((n) => [n, process.env[n]]));
}

/** Fail loudly if the RPC is not the chain this campaign expects. */
export async function assertChain(provider, expectedId) {
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== Number(expectedId)) {
    const want = chain(expectedId);
    throw new Error(
      `RPC is on chain ${net.chainId} but this campaign targets ${expectedId} (${want.name}). ` +
        `Check ${want.rpcEnv} in .env.`
    );
  }
}

/**
 * Build the provider and wallet for a chain, asserting both the environment and
 * the network before anything can be signed.
 */
export async function loadEnv({ chainId, requires = ["PRIVATE_KEY"], needsSigner = true } = {}) {
  const spec = chain(chainId);
  const names = [...new Set([...requires, spec.rpcEnv])].filter((n) => needsSigner || n !== "PRIVATE_KEY");
  const env = requireEnv(names);

  const provider = new ethers.JsonRpcProvider(env[spec.rpcEnv]);
  await assertChain(provider, chainId);

  const wallet = needsSigner ? new ethers.Wallet(env.PRIVATE_KEY, provider) : null;
  return { provider, wallet, chainId: Number(chainId), chain: spec, env };
}
