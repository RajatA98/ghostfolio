import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class DividendService {
  private readonly logger = new Logger(DividendService.name);

  public constructor(
    private readonly configurationService: ConfigurationService,
    private readonly prismaService: PrismaService
  ) {}

  public async fetchFromFMP(symbol: string) {
    const apiKey = this.configurationService.get(
      'API_KEY_FINANCIAL_MODELING_PREP'
    );

    if (!apiKey) {
      throw new Error('API_KEY_FINANCIAL_MODELING_PREP is not configured');
    }

    const url = `https://financialmodelingprep.com/api/v3/historical/stock_dividend/${symbol.toUpperCase()}?apikey=${apiKey}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `FMP API error ${response.status} for ${symbol.toUpperCase()}`
      );
    }

    const data = (await response.json()) as {
      symbol: string;
      historical: {
        date: string;
        dividend: number;
        paymentDate: string;
      }[];
    };

    if (!data.historical?.length) {
      return { symbol: symbol.toUpperCase(), dividends: [], annualEstimate: 0 };
    }

    const recent = data.historical.slice(0, 8).map((d) => ({
      exDate: d.date,
      paymentDate: d.paymentDate ?? null,
      amount: d.dividend
    }));

    const annualEstimate = recent
      .slice(0, 4)
      .reduce((sum, d) => sum + d.amount, 0);

    return {
      symbol: data.symbol,
      dividends: recent,
      annualEstimate: parseFloat(annualEstimate.toFixed(4))
    };
  }

  public async createRecord(
    userId: string,
    data: {
      symbol: string;
      exDate: string;
      paymentDate?: string;
      amount: number;
      currency?: string;
    }
  ) {
    return this.prismaService.dividendRecord.create({
      data: {
        userId,
        symbol: data.symbol.toUpperCase(),
        exDate: new Date(data.exDate),
        paymentDate: data.paymentDate ? new Date(data.paymentDate) : null,
        amount: data.amount,
        currency: data.currency ?? 'USD',
        source: 'FMP'
      }
    });
  }

  public async getRecords(userId: string, symbol?: string) {
    return this.prismaService.dividendRecord.findMany({
      where: {
        userId,
        ...(symbol ? { symbol: symbol.toUpperCase() } : {})
      },
      orderBy: { exDate: 'desc' }
    });
  }

  public async deleteRecord(userId: string, id: string) {
    await this.prismaService.dividendRecord.deleteMany({
      where: { id, userId }
    });

    return { deleted: id };
  }
}
