import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { DividendService } from '@ghostfolio/api/services/dividend/dividend.service';
import { RequestWithUser } from '@ghostfolio/common/types';

import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  UseGuards
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

@Controller('dividends')
export class DividendsController {
  public constructor(
    @Inject(REQUEST) private readonly request: RequestWithUser,
    private readonly dividendService: DividendService
  ) {}

  @Get('data/:symbol')
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async fetchDividendData(@Param('symbol') symbol: string) {
    return this.dividendService.fetchFromFMP(symbol);
  }

  @Post('records')
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async createRecord(
    @Body()
    body: {
      symbol: string;
      exDate: string;
      paymentDate?: string;
      amount: number;
      currency?: string;
    }
  ) {
    return this.dividendService.createRecord(this.request.user.id, body);
  }

  @Get('records')
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async getRecords() {
    return this.dividendService.getRecords(this.request.user.id);
  }

  @Get('records/:symbol')
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async getRecordsBySymbol(@Param('symbol') symbol: string) {
    return this.dividendService.getRecords(this.request.user.id, symbol);
  }

  @Delete('records/:id')
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async deleteRecord(@Param('id') id: string) {
    return this.dividendService.deleteRecord(this.request.user.id, id);
  }
}
