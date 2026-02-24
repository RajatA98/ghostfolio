// apps/api/src/app/agent/tools/get-portfolio-snapshot.tool.ts

import { PortfolioService } from '@ghostfolio/api/app/portfolio/portfolio.service';
import { PortfolioDetails, PortfolioPosition } from '@ghostfolio/common/interfaces';
import { DateRange } from '@ghostfolio/common/types';

import Big from 'big.js';

import {
  AllocationRow,
  HoldingRow,
  Money,
  PortfolioSnapshotResult,
  ValuationMethod
} from '../agent.types';

import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export class GetPortfolioSnapshotTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'getPortfolioSnapshot',
    description:
      'Retrieves the current portfolio holdings with allocations, values, and performance metrics. Use this tool to answer questions about portfolio composition, allocation breakdown, total value, and individual holding details.',
    input_schema: {
      type: 'object' as const,
      properties: {
        dateRange: {
          type: 'string',
          enum: ['1d', 'wtd', 'mtd', 'ytd', '1y', '5y', 'max'],
          description:
            "Time range for the snapshot. Use 'mtd' for month-to-date (≈last 30 days), 'ytd' for year-to-date, '1y' for one year, 'max' for all time. Defaults to 'max'."
        }
      },
      required: []
    }
  };

  public constructor(
    private readonly portfolioService: PortfolioService
  ) {}

  public async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<PortfolioSnapshotResult> {
    const dateRange = (input.dateRange as DateRange) ?? 'max';

    const result = await this.portfolioService.getDetails({
      dateRange,
      impersonationId: context.impersonationId,
      userId: context.userId,
      withSummary: true
    });

    return this.mapToSnapshot(result, context.baseCurrency);
  }

  private mapToSnapshot(
    details: PortfolioDetails & { hasErrors: boolean },
    baseCurrency: string
  ): PortfolioSnapshotResult {
    const positions = Object.values(details.holdings);
    let isPriceDataMissing = false;

    const holdings: HoldingRow[] = positions
      .filter(
        (pos: PortfolioPosition) =>
          pos.quantity > 0 || (pos.valueInBaseCurrency ?? 0) > 0
      )
      .map((pos: PortfolioPosition) => {
        const hasMissingPrice =
          pos.marketPrice === 0 ||
          pos.marketPrice == null ||
          pos.valueInBaseCurrency === 0 ||
          pos.valueInBaseCurrency == null;

        if (hasMissingPrice) {
          isPriceDataMissing = true;
        }

        return {
          symbol: pos.symbol,
          name: pos.name ?? null,
          quantity: pos.quantity,
          costBasis: pos.investment
            ? ({ currency: baseCurrency, amount: pos.investment } as Money)
            : null,
          price: pos.marketPrice
            ? ({
                currency: pos.currency,
                amount: pos.marketPrice
              } as Money)
            : null,
          value: pos.valueInBaseCurrency
            ? ({
                currency: baseCurrency,
                amount: pos.valueInBaseCurrency
              } as Money)
            : null,
          assetClass: pos.assetClass ?? null
        };
      });

    // Compute total value
    const totalValue = holdings.reduce((sum, h) => {
      return sum.plus(new Big(h.value?.amount ?? h.costBasis?.amount ?? 0));
    }, new Big(0));

    // Compute allocation by symbol
    const allocationBySymbol: AllocationRow[] = holdings.map((h) => {
      const holdingValue = new Big(
        h.value?.amount ?? h.costBasis?.amount ?? 0
      );
      const percent = totalValue.gt(0)
        ? holdingValue.div(totalValue).times(100).toNumber()
        : 0;

      return {
        key: h.symbol,
        value: { currency: baseCurrency, amount: holdingValue.toNumber() },
        percent: Math.round(percent * 100) / 100
      };
    });

    // Compute allocation by asset class
    const assetClassMap = new Map<string, Big>();

    for (const h of holdings) {
      const cls = h.assetClass ?? 'UNKNOWN';
      const val = new Big(h.value?.amount ?? h.costBasis?.amount ?? 0);
      assetClassMap.set(cls, (assetClassMap.get(cls) ?? new Big(0)).plus(val));
    }

    const allocationByAssetClass: AllocationRow[] = Array.from(
      assetClassMap.entries()
    ).map(([key, val]) => ({
      key,
      value: { currency: baseCurrency, amount: val.toNumber() },
      percent: totalValue.gt(0)
        ? Math.round(val.div(totalValue).times(100).toNumber() * 100) / 100
        : 0
    }));

    const valuationMethod: ValuationMethod = isPriceDataMissing
      ? 'cost_basis'
      : 'market';

    const now = new Date().toISOString().split('T')[0];

    return {
      accountId: 'default',
      timeframe: { start: '', end: now },
      valuationMethod,
      asOf: valuationMethod === 'market' ? now : null,
      totalValue: {
        currency: baseCurrency,
        amount: totalValue.toNumber()
      },
      allocationBySymbol,
      allocationByAssetClass,
      holdings,
      isPriceDataMissing
    };
  }
}
