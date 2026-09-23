import { UniswapGraphQLClient } from "@/config/apollo";
import { GetPoolsDocument, GetPoolsQuery, GetPoolsQueryVariables } from "@/gql/graphql";
import { PoolInfo } from "@/types";
import { getToken0Token1, isTwoStringsEqual, tickToTokenPrices } from "@/utils/common";
import { CHAIN_ID, ORIGINALITY_PARENT_MARKET_ID } from "@/utils/constants";
import { createClient } from "@supabase/supabase-js";
import pLimit from "p-limit";
import { Address } from "viem";

const supabase = createClient(process.env.SUPABASE_PROJECT_URL!, process.env.SUPABASE_API_KEY!);

async function getCharts(keys: string[]) {
  try {
    const chunkSize = 4;
    const concurrency = 5;

    function chunkArray(arr: any[], size: number) {
      const res = [];
      for (let i = 0; i < arr.length; i += size) {
        res.push(arr.slice(i, i + size));
      }
      return res;
    }

    const chunks = chunkArray(keys, chunkSize);
    const limit = pLimit(concurrency);

    const results = await Promise.all(
      chunks.map((chunk) =>
        limit(async () => {
          const { data, error } = await supabase.from("key_value").select("value").in("key", chunk);

          if (error) throw error;
          return data || [];
        }),
      ),
    );

    const allData = results.flat();

    return {
      data: allData,
    };
  } catch (e) {
    return {
      data: null,
      error: e,
    };
  }
}

export default async () => {
  try {
    const { data: parentMarket, error: parentMarketError } = await supabase
      .from("markets")
      .select("subgraph_data->wrappedTokens,subgraph_data->outcomes")
      .eq("id", ORIGINALITY_PARENT_MARKET_ID)
      .eq("chain_id", CHAIN_ID)
      .single();
    if (parentMarketError) {
      throw parentMarketError;
    }
    if (!parentMarket) {
      throw new Error("Parent market not found");
    }

    let { data, error } = await supabase
      .from("markets")
      .select(
        "id,subgraph_data->wrappedTokens,subgraph_data->outcomes,subgraph_data->collateralToken,subgraph_data->parentOutcome",
      )
      .eq("subgraph_data->parentMarket->>id", ORIGINALITY_PARENT_MARKET_ID)
      .eq("chain_id", CHAIN_ID);
    if (!data) {
      throw new Error("Markets not found");
    }
    if (error) {
      throw error;
    }
    const markets = data as {
      wrappedTokens: Address[];
      collateralToken: Address;
      id: Address;
      outcomes: string[];
      parentOutcome: number;
    }[];
    console.time("get chart");
    const { data: chartData, error: chartError } = await getCharts(
      markets.map((market) => `market_chart_hour_data_${market.id}_${CHAIN_ID}_deep_pm`),
    );
    console.timeEnd("get chart");
    const charts = chartError
      ? null
      : (chartData?.reduce<Record<string, any>>((acc, row) => {
          acc[row.value.marketId] = row.value.chartData;
          return acc;
        }, {}) ?? {});
    const totalVolumeMapping = chartError
      ? null
      : (chartData?.reduce<Record<string, any>>((acc, row) => {
          acc[row.value.marketId] = row.value.totalVolumeMarket;
          return acc;
        }, {}) ?? {});
    //get pools for all the markets
    const queryResult = await UniswapGraphQLClient.query<GetPoolsQuery, GetPoolsQueryVariables>({
      query: GetPoolsDocument,
      variables: {
        first: 1000,
        where: {
          or: markets.flatMap(
            ({ wrappedTokens, collateralToken }) =>
              wrappedTokens.slice(0, -1).map((token) => getToken0Token1(token, collateralToken)) ??
              [],
          ),
        },
      },
    });

    if (!queryResult.data) {
      throw { message: "No pool found" };
    }
    const pools = queryResult.data.pools;
    //we only use the pool with highest liquidity for each pair
    const tokenPairToPoolMapping = pools.reduce(
      (acc, pool) => {
        const numLiquidity = Number(pool.liquidity);
        const mappingKey = `${pool.token0.id}-${pool.token1.id}`;
        if (!acc[mappingKey] || numLiquidity > Number(acc[mappingKey].liquidity)) {
          acc[mappingKey] = pool;
        }
        return acc;
      },
      {} as { [key: string]: GetPoolsQuery["pools"][0] },
    );

    const getPoolByTokenPair = (outcome: Address, collateral: Address) => {
      const { token0, token1 } = getToken0Token1(outcome, collateral);
      const tokenPairMappingKey = `${token0}-${token1}`;
      const pool = tokenPairToPoolMapping[tokenPairMappingKey];
      if (!pool) return null;
      const {
        tick,
        ticks,
        liquidity,
        token0: { id: poolToken0Id },
        token1: { id: poolToken1Id },
      } = pool;
      const [price0, price1] = tickToTokenPrices(Number(tick));
      const price = isTwoStringsEqual(outcome, token0) ? price0 : price1;
      return {
        liquidity,
        tick,
        token0: poolToken0Id,
        token1: poolToken1Id,
        ticks,
        price,
      };
    };

    // return ticks data and current down/up price
    const repoToPriceMapping = markets.reduce(
      (mapping, market) => {
        const downPool = getPoolByTokenPair(market.wrappedTokens[0], market.collateralToken);
        const upPool = getPoolByTokenPair(market.wrappedTokens[1], market.collateralToken);
        const repo = (parentMarket.outcomes as string[])[market.parentOutcome];
        if (mapping[repo]?.upPool || mapping[repo]?.downPool) {
          return mapping;
        }
        mapping[repo] = {
          id: market.id,
          upPrice: upPool?.price ?? null,
          upPool,
          downPrice: downPool?.price ?? null,
          downPool,
        };
        return mapping;
      },
      {} as {
        [key: string]: {
          id: Address;
          upPrice: number | null;
          downPrice: number | null;
          upPool: PoolInfo | null;
          downPool: PoolInfo | null;
        };
      },
    );
    return new Response(
      JSON.stringify({
        marketsData: repoToPriceMapping,
        markets,
        charts,
        totalVolumeMapping,
        chartError,
      }),
      {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "http://localhost:5173",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Methods": "GET",
        },
      },
    );
  } catch (e: any) {
    console.log(e);
    return new Response(JSON.stringify({ error: e.message || "Internal server error" }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }
};
