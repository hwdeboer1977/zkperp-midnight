// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a Chainlink price feed, from the Aleo ZKPerp relayer
 * (zkperp-oracle/backend/shared/chainlink.js), typed and converted to the
 * contract's 6 decimals.
 *
 * Reading costs nothing: `latestRoundData` is a view call through any
 * Ethereum RPC, with no key, account or gas.
 */

import { ethers } from "ethers";

/** ETH/USD on Ethereum mainnet. Always the proxy, never the underlying aggregator. */
export const ETH_USD_MAINNET = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";

const AGGREGATOR_V3_ABI = [
  "function decimals() external view returns (uint8)",
  "function description() external view returns (string)",
  "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];

export interface Round {
  description: string;
  roundId: bigint;
  /** The price in the feed's own decimals. */
  answer: bigint;
  decimals: number;
  /** When the round was published, seconds since the epoch. */
  updatedAt: bigint;
}

export async function latestRound(rpcUrl: string, feedAddress: string): Promise<Round> {
  const feed = new ethers.Contract(feedAddress, AGGREGATOR_V3_ABI, new ethers.JsonRpcProvider(rpcUrl));
  const [decimals, description, [roundId, answer, , updatedAt]] = await Promise.all([
    feed.decimals(),
    feed.description(),
    feed.latestRoundData(),
  ]);
  if (answer <= 0n) throw new Error(`Chainlink ${feedAddress}: answer ${answer} is not a price`);
  if (updatedAt === 0n) throw new Error(`Chainlink ${feedAddress}: round ${roundId} was never updated`);
  return {
    description: String(description),
    roundId: BigInt(roundId),
    answer: BigInt(answer),
    decimals: Number(decimals),
    updatedAt: BigInt(updatedAt),
  };
}

/** A feed answer in the contract's 6 decimals, rounded down. */
export function toSixDecimals(answer: bigint, decimals: number): bigint {
  return decimals >= 6 ? answer / 10n ** BigInt(decimals - 6) : answer * 10n ** BigInt(6 - decimals);
}
