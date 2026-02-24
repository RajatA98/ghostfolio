// apps/api/src/app/agent/__tests__/agent.service.spec.ts

import { AgentService } from '../agent.service';
import { PortfolioService } from '@ghostfolio/api/app/portfolio/portfolio.service';
import {
  MOCK_PERFORMANCE,
  MOCK_PORTFOLIO_DETAILS
} from '../evals/run-evals';

// ─── Mock Anthropic SDK ──────────────────────────────────────────────────────

const mockCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: {
        create: mockCreate
      }
    }))
  };
});

// ─── Mock PortfolioService ───────────────────────────────────────────────────

function createMockPortfolioService(
  overrides: Partial<Record<string, jest.Mock>> = {}
): jest.Mocked<Partial<PortfolioService>> {
  return {
    getDetails: jest.fn().mockResolvedValue(MOCK_PORTFOLIO_DETAILS),
    getPerformance: jest.fn().mockResolvedValue(MOCK_PERFORMANCE),
    ...overrides
  } as jest.Mocked<Partial<PortfolioService>>;
}

const DEFAULT_USER_CONTEXT = {
  userId: 'test-user-id',
  baseCurrency: 'USD',
  language: 'en'
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('AgentService', () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    mockCreate.mockReset();
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
  });

  describe('configuration', () => {
    it('should return error when ANTHROPIC_API_KEY is not set', async () => {
      delete process.env.ANTHROPIC_API_KEY;

      const mockPortfolio = createMockPortfolioService();
      const service = new AgentService(
        mockPortfolio as unknown as PortfolioService
      );

      const result = await service.chat(
        { message: 'hello' },
        DEFAULT_USER_CONTEXT
      );

      expect(result.answer).toContain('not currently configured');
      expect(result.confidence).toBe(0.1);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('direct LLM response (no tool calls)', () => {
    it('should return text response when LLM answers without tools', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: 'Hello! I can help you analyze your portfolio. What would you like to know?'
          }
        ],
        stop_reason: 'end_turn'
      });

      const mockPortfolio = createMockPortfolioService();
      const service = new AgentService(
        mockPortfolio as unknown as PortfolioService
      );

      const result = await service.chat(
        { message: 'hello' },
        DEFAULT_USER_CONTEXT
      );

      expect(result.answer).toContain('analyze your portfolio');
      expect(result.toolTrace).toHaveLength(0);
      expect(result.warnings).toEqual([]);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('tool execution flow', () => {
    it('should execute getPortfolioSnapshot and generate response', async () => {
      // Call #1: LLM requests tool
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'getPortfolioSnapshot',
            input: { dateRange: 'max' }
          }
        ],
        stop_reason: 'tool_use'
      });

      // Call #2: LLM generates final answer
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: 'Your portfolio has a totalValue of $5,003. The valuationMethod is market. AAPL: 37.08%, VTI: 39.18%, BND: 23.74%.'
          }
        ],
        stop_reason: 'end_turn'
      });

      const mockPortfolio = createMockPortfolioService();
      const service = new AgentService(
        mockPortfolio as unknown as PortfolioService
      );

      const result = await service.chat(
        { message: "What's my portfolio allocation?" },
        DEFAULT_USER_CONTEXT
      );

      expect(result.toolTrace).toHaveLength(1);
      expect(result.toolTrace[0].tool).toBe('getPortfolioSnapshot');
      expect(result.toolTrace[0].ok).toBe(true);
      expect(mockPortfolio.getDetails).toHaveBeenCalled();
      expect(result.answer).toContain('5,003');
      expect(result.data.valuationMethod).toBe('market');
      expect(result.data.allocationBySymbol).toBeDefined();
      expect(result.data.allocationBySymbol!.length).toBe(3);
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('should execute multiple tools in a single plan', async () => {
      // Call #1: LLM requests both snapshot and performance
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'getPortfolioSnapshot',
            input: { dateRange: 'mtd' }
          },
          {
            type: 'tool_use',
            id: 'tool_2',
            name: 'getPerformance',
            input: { dateRange: 'mtd' }
          }
        ],
        stop_reason: 'tool_use'
      });

      // Call #2: LLM generates answer
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: 'Your portfolio returned 11.18% over this period. valuationMethod: market.'
          }
        ],
        stop_reason: 'end_turn'
      });

      const mockPortfolio = createMockPortfolioService();
      const service = new AgentService(
        mockPortfolio as unknown as PortfolioService
      );

      const result = await service.chat(
        { message: 'How did my portfolio perform recently?' },
        DEFAULT_USER_CONTEXT
      );

      expect(result.toolTrace).toHaveLength(2);
      expect(result.toolTrace[0].tool).toBe('getPortfolioSnapshot');
      expect(result.toolTrace[1].tool).toBe('getPerformance');
      expect(result.toolTrace.every((t) => t.ok)).toBe(true);
      expect(mockPortfolio.getDetails).toHaveBeenCalled();
      expect(mockPortfolio.getPerformance).toHaveBeenCalled();
    });

    it('should execute simulateAllocationChange tool', async () => {
      // Call #1: LLM requests snapshot + simulate
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'getPortfolioSnapshot',
            input: {}
          },
          {
            type: 'tool_use',
            id: 'tool_2',
            name: 'simulateAllocationChange',
            input: {
              changes: [
                {
                  type: 'buy',
                  symbol: 'VTI',
                  amount: { currency: 'USD', amount: 500 }
                }
              ]
            }
          }
        ],
        stop_reason: 'tool_use'
      });

      // Call #2: Answer
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: 'If you add $500 of VTI, your new allocation would change. The new allocation shows VTI at a higher percentage. valuationMethod: market.'
          }
        ],
        stop_reason: 'end_turn'
      });

      const mockPortfolio = createMockPortfolioService();
      const service = new AgentService(
        mockPortfolio as unknown as PortfolioService
      );

      const result = await service.chat(
        { message: 'What if I add $500 of VTI?' },
        DEFAULT_USER_CONTEXT
      );

      expect(result.toolTrace).toHaveLength(2);
      expect(
        result.toolTrace.find((t) => t.tool === 'simulateAllocationChange')
      ).toBeDefined();
      // getDetails called twice: once for snapshot, once for simulate
      expect(mockPortfolio.getDetails).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('should handle tool execution errors gracefully', async () => {
      // Call #1: LLM requests tool
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'getPortfolioSnapshot',
            input: {}
          }
        ],
        stop_reason: 'tool_use'
      });

      // Call #2: LLM responds based on error
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: "I couldn't retrieve your portfolio data due to a database error. Please try again later."
          }
        ],
        stop_reason: 'end_turn'
      });

      const mockPortfolio = createMockPortfolioService({
        getDetails: jest
          .fn()
          .mockRejectedValue(new Error('Database connection failed'))
      });

      const service = new AgentService(
        mockPortfolio as unknown as PortfolioService
      );

      const result = await service.chat(
        { message: "What's my allocation?" },
        DEFAULT_USER_CONTEXT
      );

      // Tool should be traced as failed
      expect(result.toolTrace).toHaveLength(1);
      expect(result.toolTrace[0].ok).toBe(false);
      expect(result.toolTrace[0].error).toContain(
        'Database connection failed'
      );
      // Should still return a response, not crash
      expect(result.answer).toBeDefined();
      expect(result.answer.length).toBeGreaterThan(0);
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('should handle LLM API errors gracefully', async () => {
      mockCreate.mockRejectedValueOnce(
        new Error('API rate limit exceeded')
      );

      const mockPortfolio = createMockPortfolioService();
      const service = new AgentService(
        mockPortfolio as unknown as PortfolioService
      );

      const result = await service.chat(
        { message: "What's my allocation?" },
        DEFAULT_USER_CONTEXT
      );

      expect(result.answer).toContain('error');
      expect(result.confidence).toBe(0.1);
    });

    it('should handle unknown tool names in LLM response', async () => {
      // Call #1: LLM requests non-existent tool
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'nonExistentTool',
            input: {}
          }
        ],
        stop_reason: 'tool_use'
      });

      // Call #2: LLM responds about the failed tool
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: 'I was unable to use that tool. Let me try a different approach.'
          }
        ],
        stop_reason: 'end_turn'
      });

      const mockPortfolio = createMockPortfolioService();
      const service = new AgentService(
        mockPortfolio as unknown as PortfolioService
      );

      const result = await service.chat(
        { message: 'test' },
        DEFAULT_USER_CONTEXT
      );

      expect(result.toolTrace).toHaveLength(1);
      expect(result.toolTrace[0].ok).toBe(false);
      expect(result.toolTrace[0].error).toContain('Unknown');
    });
  });

  describe('verification', () => {
    it('should add warnings for advisory language in direct response', async () => {
      // LLM answers directly with advisory language
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: 'You should buy more AAPL because it has guaranteed returns.'
          }
        ],
        stop_reason: 'end_turn'
      });

      const mockPortfolio = createMockPortfolioService();
      const service = new AgentService(
        mockPortfolio as unknown as PortfolioService
      );

      const result = await service.chat(
        { message: 'What should I do?' },
        DEFAULT_USER_CONTEXT
      );

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(
        result.warnings.some((w) => w.toLowerCase().includes('advice'))
      ).toBe(true);
    });
  });

  describe('conversation history', () => {
    it('should pass conversation history to the LLM', async () => {
      // LLM answers directly
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: 'Based on our previous discussion, your bond allocation is 23.74%.'
          }
        ],
        stop_reason: 'end_turn'
      });

      const mockPortfolio = createMockPortfolioService();
      const service = new AgentService(
        mockPortfolio as unknown as PortfolioService
      );

      await service.chat(
        {
          message: 'And what about bonds?',
          conversationHistory: [
            { role: 'user', content: "What's my allocation?" },
            {
              role: 'assistant',
              content: 'Your portfolio is 60% stocks, 40% bonds.'
            }
          ]
        },
        DEFAULT_USER_CONTEXT
      );

      // Verify the messages passed to the LLM include history
      expect(mockCreate).toHaveBeenCalledTimes(1);
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages).toHaveLength(3); // 2 history + 1 new
      expect(callArgs.messages[0].role).toBe('user');
      expect(callArgs.messages[0].content).toContain('allocation');
      expect(callArgs.messages[1].role).toBe('assistant');
      expect(callArgs.messages[2].role).toBe('user');
      expect(callArgs.messages[2].content).toBe('And what about bonds?');
    });
  });

  describe('confidence scoring', () => {
    it('should set confidence to 1.0 for full market data', async () => {
      // Call #1: Request snapshot
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'getPortfolioSnapshot',
            input: {}
          }
        ],
        stop_reason: 'tool_use'
      });

      // Call #2: Generate answer
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: 'Your portfolio allocation is: AAPL 37.08%, VTI 39.18%, BND 23.74%. valuationMethod: market.'
          }
        ],
        stop_reason: 'end_turn'
      });

      const mockPortfolio = createMockPortfolioService();
      const service = new AgentService(
        mockPortfolio as unknown as PortfolioService
      );

      const result = await service.chat(
        { message: "What's my allocation?" },
        DEFAULT_USER_CONTEXT
      );

      expect(result.confidence).toBe(1.0);
    });
  });
});
