// apps/api/src/app/agent/agent.service.ts

import { PortfolioService } from '@ghostfolio/api/app/portfolio/portfolio.service';

import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

import { agentConfig } from './agent.config';
import { buildSystemPrompt } from './agent.prompt';
import {
  AgentChatRequest,
  AgentChatResponse,
  PortfolioSnapshotResult,
  ToolTraceRow,
  ValuationMethod
} from './agent.types';
import {
  computeConfidence,
  verifyAgentResponse
} from './agent.verifier';
import { GetMarketPricesTool } from './tools/get-market-prices.tool';
import { GetPerformanceTool } from './tools/get-performance.tool';
import { GetPortfolioSnapshotTool } from './tools/get-portfolio-snapshot.tool';
import { SimulateAllocationChangeTool } from './tools/simulate-allocation-change.tool';
import { ToolContext, ToolRegistry } from './tools/tool-registry';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly toolRegistry: ToolRegistry;

  public constructor(
    private readonly portfolioService: PortfolioService
  ) {
    this.toolRegistry = new ToolRegistry();

    // Register tools
    this.toolRegistry.register({
      definition: GetPortfolioSnapshotTool.DEFINITION,
      executor: new GetPortfolioSnapshotTool(this.portfolioService),
      enabled: true
    });

    this.toolRegistry.register({
      definition: GetPerformanceTool.DEFINITION,
      executor: new GetPerformanceTool(this.portfolioService),
      enabled: true
    });

    this.toolRegistry.register({
      definition: SimulateAllocationChangeTool.DEFINITION,
      executor: new SimulateAllocationChangeTool(this.portfolioService),
      enabled: true
    });

    this.toolRegistry.register({
      definition: GetMarketPricesTool.DEFINITION,
      executor: new GetMarketPricesTool(),
      enabled: agentConfig.enableExternalMarketData
    });
  }

  public async chat(
    request: AgentChatRequest,
    userContext: {
      userId: string;
      baseCurrency: string;
      language: string;
      impersonationId?: string;
    }
  ): Promise<AgentChatResponse> {
    // Check if agent is configured
    if (!agentConfig.anthropicApiKey) {
      return this.buildErrorResponse(
        'The portfolio analysis agent is not currently configured. Please set the ANTHROPIC_API_KEY environment variable.',
        []
      );
    }

    const toolTrace: ToolTraceRow[] = [];
    const toolResults = new Map<string, unknown>();
    let toolsSucceeded = 0;
    let toolsFailed = 0;

    try {
      const client = new Anthropic({ apiKey: agentConfig.anthropicApiKey });

      const systemPrompt = buildSystemPrompt({
        baseCurrency: userContext.baseCurrency,
        language: userContext.language,
        currentDate: new Date().toISOString().split('T')[0]
      });

      // Build messages from conversation history
      const messages: Anthropic.MessageParam[] = [];

      if (request.conversationHistory) {
        for (const msg of request.conversationHistory) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }

      messages.push({ role: 'user', content: request.message });

      // Get tool definitions for the LLM
      const toolDefinitions = this.toolRegistry.getDefinitions();
      const anthropicTools: Anthropic.Tool[] = toolDefinitions.map((td) => ({
        name: td.name,
        description: td.description,
        input_schema: td.input_schema as Anthropic.Tool.InputSchema
      }));

      // ===== LLM CALL #1: Plan + Tool Selection =====
      this.logger.log('LLM Call #1: Planning tool calls...');

      const call1Response = await client.messages.create({
        model: agentConfig.anthropicModel,
        max_tokens: agentConfig.maxTokens,
        temperature: agentConfig.temperature,
        system: systemPrompt,
        messages,
        tools: anthropicTools
      });

      // Extract tool_use blocks
      const toolUseBlocks = call1Response.content.filter(
        (block): block is Anthropic.ToolUseBlock =>
          block.type === 'tool_use'
      );

      // If LLM answered directly (no tool calls), return the text response
      if (toolUseBlocks.length === 0) {
        const textContent = this.extractText(call1Response.content);

        const verification = verifyAgentResponse({
          answer: textContent,
          toolResults
        });

        return {
          answer: textContent,
          data: {
            valuationMethod: 'market',
            asOf: null
          },
          toolTrace,
          confidence: computeConfidence({
            hasErrors: false,
            isPriceDataMissing: false,
            toolsSucceeded: 0,
            toolsFailed: 0,
            hasHoldings: true
          }),
          warnings: verification.warnings
        };
      }

      // ===== Execute Tool Calls =====
      const toolContext: ToolContext = {
        userId: userContext.userId,
        baseCurrency: userContext.baseCurrency,
        impersonationId: userContext.impersonationId
      };

      const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        const startMs = Date.now();
        const executor = this.toolRegistry.getExecutor(toolUse.name);

        if (!executor) {
          const errorMsg = `Unknown or disabled tool: ${toolUse.name}`;
          this.logger.warn(errorMsg);
          toolsFailed++;

          toolTrace.push({
            tool: toolUse.name,
            ok: false,
            ms: Date.now() - startMs,
            error: errorMsg
          });

          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({ error: errorMsg }),
            is_error: true
          });

          continue;
        }

        try {
          this.logger.log(
            `Executing tool: ${toolUse.name} with input: ${JSON.stringify(toolUse.input)}`
          );

          const result = await executor.execute(
            toolUse.input as Record<string, unknown>,
            toolContext
          );

          toolResults.set(toolUse.name, result);
          toolsSucceeded++;

          toolTrace.push({
            tool: toolUse.name,
            ok: true,
            ms: Date.now() - startMs
          });

          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result)
          });
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          this.logger.error(`Tool ${toolUse.name} failed: ${errorMsg}`);
          toolsFailed++;

          toolTrace.push({
            tool: toolUse.name,
            ok: false,
            ms: Date.now() - startMs,
            error: errorMsg
          });

          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              error: `Tool execution failed: ${errorMsg}`
            }),
            is_error: true
          });
        }
      }

      // ===== LLM CALL #2: Generate Final Answer =====
      this.logger.log('LLM Call #2: Generating final answer...');

      const call2Messages: Anthropic.MessageParam[] = [
        ...messages,
        { role: 'assistant', content: call1Response.content },
        { role: 'user', content: toolResultBlocks }
      ];

      const call2Response = await client.messages.create({
        model: agentConfig.anthropicModel,
        max_tokens: agentConfig.maxTokens,
        temperature: agentConfig.temperature,
        system: systemPrompt,
        messages: call2Messages,
        tools: anthropicTools
      });

      const answer = this.extractText(call2Response.content);

      // ===== Verification =====
      const verification = verifyAgentResponse({
        answer,
        toolResults
      });

      // Extract structured data from snapshot result
      const snapshotResult = toolResults.get('getPortfolioSnapshot') as
        | PortfolioSnapshotResult
        | undefined;

      const isPriceDataMissing =
        snapshotResult?.isPriceDataMissing ?? false;
      const hasHoldings =
        (snapshotResult?.holdings?.length ?? 0) > 0;
      const hasErrors = snapshotResult
        ? false
        : toolsFailed > 0;

      const baseConfidence = computeConfidence({
        hasErrors,
        isPriceDataMissing,
        toolsSucceeded,
        toolsFailed,
        hasHoldings
      });

      const finalConfidence = Math.max(
        0,
        baseConfidence - verification.confidenceAdjustment
      );

      const valuationMethod: ValuationMethod =
        snapshotResult?.valuationMethod ?? 'market';

      return {
        answer,
        data: {
          valuationMethod,
          asOf: snapshotResult?.asOf ?? null,
          totalValue: snapshotResult?.totalValue,
          allocationBySymbol: snapshotResult?.allocationBySymbol,
          allocationByAssetClass: snapshotResult?.allocationByAssetClass
        },
        toolTrace,
        confidence: finalConfidence,
        warnings: verification.warnings
      };
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Agent chat failed: ${errorMsg}`);

      return this.buildErrorResponse(
        `I encountered an error while processing your request. Please try again. (${errorMsg})`,
        toolTrace
      );
    }
  }

  private extractText(
    content: Anthropic.ContentBlock[]
  ): string {
    return content
      .filter(
        (block): block is Anthropic.TextBlock => block.type === 'text'
      )
      .map((block) => block.text)
      .join('\n');
  }

  private buildErrorResponse(
    message: string,
    toolTrace: ToolTraceRow[]
  ): AgentChatResponse {
    return {
      answer: message,
      data: {
        valuationMethod: 'market',
        asOf: null
      },
      toolTrace,
      confidence: 0.1,
      warnings: []
    };
  }
}
