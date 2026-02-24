// apps/api/src/app/agent/agent.types.ts
// Tool + response schemas for the Ghostfolio Portfolio Analysis Agent (MVP)
//
// Notes:
// - Keep these types stable; they are used for tool contracts, verification, and evals.
// - For MVP, we default to valuationMethod="market" when Ghostfolio provides price/value.
//   Otherwise we fall back to "cost_basis" and set isPriceDataMissing=true.

export type IsoDate = string;

export interface Timeframe {
  start: IsoDate; // inclusive, e.g. "2026-01-01"
  end: IsoDate; // inclusive, e.g. "2026-02-01"
}

export type ValuationMethod = 'market' | 'cost_basis';

export interface Money {
  currency: 'USD' | 'EUR' | string;
  amount: number;
}

export interface HoldingRow {
  symbol: string; // e.g. "AAPL"
  name?: string | null;
  quantity: number;

  // Total cost basis (what you paid) for the holding.
  costBasis?: Money | null;

  // Latest price/value if available (from Ghostfolio internal pricing or our provider later).
  price?: Money | null;
  value?: Money | null; // quantity * price (or internal valuation), else null

  // Optional metadata
  assetClass?: string | null; // e.g. "equity" | "crypto" | "cash" (if you can map it)
}

export interface AllocationRow {
  key: string; // symbol or assetClass key
  value: Money; // value used for allocation (market or cost_basis)
  percent: number; // 0..100
}

export interface PortfolioSnapshotResult {
  accountId: string;
  timeframe: Timeframe;

  valuationMethod: ValuationMethod;

  // Timestamp of the valuation/prices. If cost_basis-only, set null.
  asOf: IsoDate | null;

  totalValue: Money;

  allocationBySymbol: AllocationRow[];
  allocationByAssetClass?: AllocationRow[];

  holdings: HoldingRow[];

  // True if any holding lacks price/value and valuationMethod fell back to cost basis.
  isPriceDataMissing: boolean;
}

export interface PerformancePoint {
  date: IsoDate;
  value: Money; // portfolio value at date (if available)
  returnPercent?: number | null; // optional
}

export interface ContributionRow {
  symbol: string;
  contributionPercent: number; // contribution to total return over timeframe
}

export interface PerformanceResult {
  accountId: string;
  timeframe: Timeframe;

  valuationMethod: ValuationMethod;
  asOf: IsoDate | null;

  // null if not computable from available data for MVP
  totalReturnPercent: number | null;

  timeSeries?: PerformancePoint[];
  contributions?: ContributionRow[];

  reasonIfUnavailable?: string | null;
}

export type AllocationChange =
  | { type: 'buy'; symbol: string; amount: Money }
  | { type: 'sell'; symbol: string; amount: Money };

export interface SimulateAllocationResult {
  accountId: string;
  timeframe: Timeframe;

  valuationMethod: ValuationMethod;
  asOf: IsoDate | null;

  originalTotalValue: Money;
  newTotalValue: Money;

  newAllocationBySymbol: AllocationRow[];

  notes: string[];
}

export interface MarketPriceRow {
  symbol: string;
  price: Money;
  asOf: IsoDate;
  source: string; // provider name
}

export interface MarketPricesResult {
  rows: MarketPriceRow[];
  asOf: IsoDate;
  source: string;
}

export interface ToolTraceRow {
  tool: string;
  ok: boolean;
  ms: number;
  error?: string | null;
}

export interface AgentChatRequest {
  message: string;
  accountId?: string;
  timeframe?: Timeframe;
  conversationHistory?: { role: 'user' | 'assistant'; content: string }[];
  mode?: 'analysis' | 'education';
}

export interface AgentChatResponse {
  answer: string;

  data: {
    valuationMethod: ValuationMethod;
    asOf: IsoDate | null;

    // Optional structured outputs for UI
    totalValue?: Money;
    allocationBySymbol?: AllocationRow[];
    allocationByAssetClass?: AllocationRow[];
  };

  toolTrace: ToolTraceRow[];
  confidence: number; // 0..1
  warnings: string[];
}
