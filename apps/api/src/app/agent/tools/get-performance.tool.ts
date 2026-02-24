// apps/api/src/app/agent/tools/get-performance.tool.ts

import { PortfolioService } from '@ghostfolio/api/app/portfolio/portfolio.service';
import { HistoricalDataItem } from '@ghostfolio/common/interfaces';
import { DateRange } from '@ghostfolio/common/types';

import {
  PerformancePoint,
  PerformanceResult,
  ValuationMethod
} from '../agent.types';

import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

const MAX_CHART_POINTS = 20;

export class GetPerformanceTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'getPerformance',
    description:
      'Retrieves portfolio performance metrics and historical chart data for a given time range. Returns total return percentage, net performance, and a time series of portfolio values.',
    input_schema: {
      type: 'object' as const,
      properties: {
        dateRange: {
          type: 'string',
          enum: ['1d', 'wtd', 'mtd', 'ytd', '1y', '5y', 'max'],
          description:
            "Time range for performance data. Use 'mtd' for month-to-date (≈last 30 days), 'ytd' for year-to-date, '1y' for one year, 'max' for all time."
        }
      },
      required: ['dateRange']
    }
  };

  public constructor(
    private readonly portfolioService: PortfolioService
  ) {}

  public async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<PerformanceResult> {
    const dateRange = (input.dateRange as DateRange) ?? 'max';

    try {
      const result = await this.portfolioService.getPerformance({
        dateRange,
        impersonationId: context.impersonationId,
        userId: context.userId
      });

      const chart = result.chart ?? [];
      const sampledChart = this.sampleChart(chart, MAX_CHART_POINTS);

      const timeSeries: PerformancePoint[] = sampledChart.map((item) => ({
        date: item.date,
        value: {
          currency: context.baseCurrency,
          amount: item.netWorth ?? 0
        },
        returnPercent: item.netPerformanceInPercentage ?? null
      }));

      const totalReturnPercent =
        result.performance?.netPerformancePercentage ?? null;

      const valuationMethod: ValuationMethod = result.hasErrors
        ? 'cost_basis'
        : 'market';

      const now = new Date().toISOString().split('T')[0];

      return {
        accountId: 'default',
        timeframe: { start: '', end: now },
        valuationMethod,
        asOf: now,
        totalReturnPercent,
        timeSeries,
        reasonIfUnavailable: result.hasErrors
          ? 'Some data may be incomplete or contain errors.'
          : null
      };
    } catch (error) {
      const now = new Date().toISOString().split('T')[0];

      return {
        accountId: 'default',
        timeframe: { start: '', end: now },
        valuationMethod: 'cost_basis',
        asOf: null,
        totalReturnPercent: null,
        timeSeries: [],
        reasonIfUnavailable: `Performance data is not available: ${error.message}`
      };
    }
  }

  private sampleChart(
    chart: HistoricalDataItem[],
    maxPoints: number
  ): HistoricalDataItem[] {
    if (chart.length <= maxPoints) {
      return chart;
    }

    const step = Math.ceil(chart.length / maxPoints);
    const sampled = chart.filter((_, i) => i % step === 0);

    // Always include the last data point
    if (
      chart.length > 0 &&
      sampled[sampled.length - 1] !== chart[chart.length - 1]
    ) {
      sampled.push(chart[chart.length - 1]);
    }

    return sampled;
  }
}
