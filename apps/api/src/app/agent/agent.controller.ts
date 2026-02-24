// apps/api/src/app/agent/agent.controller.ts

import { HasPermission } from '@ghostfolio/api/decorators/has-permission.decorator';
import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { permissions } from '@ghostfolio/common/permissions';
import type { RequestWithUser } from '@ghostfolio/common/types';

import {
  Body,
  Controller,
  HttpException,
  Inject,
  Logger,
  Post,
  UseGuards
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { StatusCodes } from 'http-status-codes';

import { AgentService } from './agent.service';
import { AgentChatRequest, AgentChatResponse } from './agent.types';

@Controller('agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  public constructor(
    private readonly agentService: AgentService,
    @Inject(REQUEST) private readonly request: RequestWithUser
  ) {}

  @Post('chat')
  @HasPermission(permissions.readAiPrompt)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async chat(
    @Body() body: AgentChatRequest
  ): Promise<AgentChatResponse> {
    try {
      return await this.agentService.chat(body, {
        userId: this.request.user.id,
        baseCurrency:
          this.request.user.settings?.settings?.baseCurrency ?? 'USD',
        language:
          this.request.user.settings?.settings?.language ?? 'en',
        impersonationId: undefined
      });
    } catch (error) {
      this.logger.error(
        `Agent chat error: ${error instanceof Error ? error.message : String(error)}`
      );

      throw new HttpException(
        'An error occurred while processing your request.',
        StatusCodes.INTERNAL_SERVER_ERROR
      );
    }
  }
}
