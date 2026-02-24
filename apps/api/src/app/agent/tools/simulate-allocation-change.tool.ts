// apps/api/src/app/agent/tools/simulate-allocation-change.tool.ts

import { PortfolioService } from '@ghostfolio/api/app/portfolio/portfolio.service';

import Big from 'big.js';

import {
  AllocationChange,
  AllocationRow,
  SimulateAllocationResult,
  ValuationMethod
} from '../agent.types';

import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export class SimulateAllocationChangeTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'simulateAllocationChange',
    description:
      'Simulates hypothetical buy/sell changes to the portfolio and shows the resulting new allocation. This is a read-only simulation — no actual transactions are made. Use this to answer "what if I buy/sell X" questions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['buy', 'sell'],
                description: 'Whether to simulate buying or selling'
              },
              symbol: {
                type: 'string',
                description: 'Ticker symbol (e.g. "VTI", "AAPL")'
              },
              amount: {
                type: 'object',
                properties: {
                  currency: {
                    type: 'string',
                    description: 'Currency code (e.g. "USD")'
                  },
                  amount: {
                    type: 'number',
                    description: 'Dollar amount to buy or sell'
                  }
                },
                required: ['currency', 'amount']
              }
            },
            required: ['type', 'symbol', 'amount']
          },
          description:
            'Array of hypothetical buy/sell changes to simulate'
        }
      },
      required: ['changes']
    }
  };

  public constructor(
    private readonly portfolioService: PortfolioService
  ) {}

  public async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<SimulateAllocationResult> {
    const changes = input.changes as AllocationChange[];

    // Fetch current portfolio state
    const details = await this.portfolioService.getDetails({
      impersonationId: context.impersonationId,
      userId: context.userId,
      withSummary: true
    });

    const positions = Object.values(details.holdings);
    const notes: string[] = [];

    // Build a map of current values by symbol
    const valueMap = new Map<string, Big>();

    for (const pos of positions) {
      if (pos.quantity > 0 || (pos.valueInBaseCurrency ?? 0) > 0) {
        valueMap.set(
          pos.symbol,
          new Big(pos.valueInBaseCurrency ?? pos.investment ?? 0)
        );
      }
    }

    // Compute original total
    let originalTotal = new Big(0);

    for (const val of valueMap.values()) {
      originalTotal = originalTotal.plus(val);
    }

    // Apply changes
    let newTotal = new Big(originalTotal);

    for (const change of changes) {
      const changeAmount = new Big(change.amount.amount);
      const currentValue = valueMap.get(change.symbol) ?? new Big(0);

      if (change.type === 'buy') {
        valueMap.set(change.symbol, currentValue.plus(changeAmount));
        newTotal = newTotal.plus(changeAmount);
        notes.push(
          `Simulated buying ${change.amount.currency} ${change.amount.amount} of ${change.symbol}`
        );
      } else if (change.type === 'sell') {
        const newValue = currentValue.minus(changeAmount);

        if (newValue.lt(0)) {
          notes.push(
            `Warning: Selling ${change.amount.currency} ${change.amount.amount} of ${change.symbol} exceeds current value (${currentValue.toFixed(2)}). Clamped to 0.`
          );
          valueMap.set(change.symbol, new Big(0));
          newTotal = newTotal.minus(currentValue);
        } else {
          valueMap.set(change.symbol, newValue);
          newTotal = newTotal.minus(changeAmount);
        }
      }
    }

    // Compute new allocation
    const newAllocationBySymbol: AllocationRow[] = [];

    for (const [symbol, value] of valueMap.entries()) {
      if (value.gt(0)) {
        newAllocationBySymbol.push({
          key: symbol,
          value: {
            currency: context.baseCurrency,
            amount: value.toNumber()
          },
          percent: newTotal.gt(0)
            ? Math.round(
                value.div(newTotal).times(100).toNumber() * 100
              ) / 100
            : 0
        });
      }
    }

    // Sort by percent descending
    newAllocationBySymbol.sort((a, b) => b.percent - a.percent);

    const isPriceDataMissing = positions.some(
      (pos) => pos.marketPrice === 0 || pos.marketPrice == null
    );
    const valuationMethod: ValuationMethod = isPriceDataMissing
      ? 'cost_basis'
      : 'market';
    const now = new Date().toISOString().split('T')[0];

    return {
      accountId: 'default',
      timeframe: { start: '', end: now },
      valuationMethod,
      asOf: valuationMethod === 'market' ? now : null,
      originalTotalValue: {
        currency: context.baseCurrency,
        amount: originalTotal.toNumber()
      },
      newTotalValue: {
        currency: context.baseCurrency,
        amount: newTotal.toNumber()
      },
      newAllocationBySymbol,
      notes
    };
  }
}
