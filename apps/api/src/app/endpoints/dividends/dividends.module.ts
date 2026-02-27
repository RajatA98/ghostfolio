import { DividendModule } from '@ghostfolio/api/services/dividend/dividend.module';
import { PrismaModule } from '@ghostfolio/api/services/prisma/prisma.module';

import { Module } from '@nestjs/common';

import { DividendsController } from './dividends.controller';

@Module({
  controllers: [DividendsController],
  imports: [DividendModule, PrismaModule]
})
export class DividendsModule {}
