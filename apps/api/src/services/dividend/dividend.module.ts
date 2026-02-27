import { ConfigurationModule } from '@ghostfolio/api/services/configuration/configuration.module';
import { PrismaModule } from '@ghostfolio/api/services/prisma/prisma.module';

import { Module } from '@nestjs/common';

import { DividendService } from './dividend.service';

@Module({
  exports: [DividendService],
  imports: [ConfigurationModule, PrismaModule],
  providers: [DividendService]
})
export class DividendModule {}
