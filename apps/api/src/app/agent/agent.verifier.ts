// apps/api/src/app/agent/agent.verifier.ts

import Big from 'big.js';

import {
  AllocationRow,
  PortfolioSnapshotResult
} from './agent.types';

const ALLOCATION_SUM_TOLERANCE = 1.0; // ±1%

const FORBIDDEN_ADVICE_PATTERNS = [
  /you should (buy|sell|invest in|divest from)/i,
  /I recommend (buying|selling|investing|purchasing)/i,
  /you must (buy|sell|invest)/i,
  /guaranteed (returns?|profits?|gains?)/i,
  /I (advise|suggest) (you )?(buy|sell|purchase)/i,
  /allocate exactly/i
];

const VALUATION_KEYWORDS = [
  'cost basis',
  'cost-basis',
  'costbasis',
  "price data isn't available",
  'price data is not available',
  'market price data is missing',
  'based on cost'
];

export interface VerificationResult {
  warnings: string[];
  confidenceAdjustment: number; // amount to subtract from confidence (0 = no change)
}

/**
 * Verifies the agent's response for correctness and compliance.
 * Returns warnings and confidence adjustments.
 */
export function verifyAgentResponse({
  answer,
  toolResults
}: {
  answer: string;
  toolResults: Map<string, unknown>;
}): VerificationResult {
  const warnings: string[] = [];
  let confidenceAdjustment = 0;

  // Check 1: Advice boundary
  const adviceResult = checkAdviceBoundary(answer);
  warnings.push(...adviceResult.warnings);
  confidenceAdjustment += adviceResult.confidenceAdjustment;

  // Check 2: Allocation sum (if snapshot data is available)
  const snapshotResult = toolResults.get('getPortfolioSnapshot') as
    | PortfolioSnapshotResult
    | undefined;

  if (snapshotResult?.allocationBySymbol) {
    const allocationResult = checkAllocationSum(
      snapshotResult.allocationBySymbol
    );
    warnings.push(...allocationResult.warnings);
    confidenceAdjustment += allocationResult.confidenceAdjustment;
  }

  // Check 3: Valuation label (if price data is missing)
  if (snapshotResult?.isPriceDataMissing) {
    const valuationResult = checkValuationLabel(answer);
    warnings.push(...valuationResult.warnings);
    confidenceAdjustment += valuationResult.confidenceAdjustment;
  }

  return { warnings, confidenceAdjustment };
}

/**
 * Check 1: Scan for forbidden advisory language.
 */
function checkAdviceBoundary(answer: string): VerificationResult {
  const warnings: string[] = [];
  let confidenceAdjustment = 0;

  for (const pattern of FORBIDDEN_ADVICE_PATTERNS) {
    if (pattern.test(answer)) {
      warnings.push(
        'Response may contain financial advice language. The agent should provide educational analysis only, not specific buy/sell recommendations.'
      );
      confidenceAdjustment += 0.2;
      break; // One warning is enough
    }
  }

  return { warnings, confidenceAdjustment };
}

/**
 * Check 2: Verify allocation percentages sum to ≈100%.
 */
function checkAllocationSum(
  allocations: AllocationRow[]
): VerificationResult {
  const warnings: string[] = [];
  let confidenceAdjustment = 0;

  if (allocations.length === 0) {
    return { warnings, confidenceAdjustment };
  }

  const sum = allocations.reduce((acc, row) => {
    return acc.plus(new Big(row.percent));
  }, new Big(0));

  const diff = sum.minus(100).abs().toNumber();

  if (diff > ALLOCATION_SUM_TOLERANCE) {
    warnings.push(
      `Allocation percentages sum to ${sum.toFixed(2)}%, which deviates from 100% by ${diff.toFixed(2)}%. This may indicate a calculation error.`
    );
    confidenceAdjustment += 0.1;
  }

  return { warnings, confidenceAdjustment };
}

/**
 * Check 3: When price data is missing, verify the response mentions cost basis.
 */
function checkValuationLabel(answer: string): VerificationResult {
  const warnings: string[] = [];
  let confidenceAdjustment = 0;

  const mentionsCostBasis = VALUATION_KEYWORDS.some((keyword) =>
    answer.toLowerCase().includes(keyword.toLowerCase())
  );

  if (!mentionsCostBasis) {
    warnings.push(
      'Price data is missing for some holdings, but the response does not mention that values are based on cost basis. Users should be informed when market prices are unavailable.'
    );
    confidenceAdjustment += 0.1;
  }

  return { warnings, confidenceAdjustment };
}

/**
 * Compute confidence score based on tool execution results.
 */
export function computeConfidence({
  hasErrors,
  isPriceDataMissing,
  toolsSucceeded,
  toolsFailed,
  hasHoldings
}: {
  hasErrors: boolean;
  isPriceDataMissing: boolean;
  toolsSucceeded: number;
  toolsFailed: number;
  hasHoldings: boolean;
}): number {
  if (toolsFailed > 0 && toolsSucceeded === 0) {
    return 0.1; // Major tool failure
  }

  if (!hasHoldings) {
    return 0.4; // Empty portfolio
  }

  if (toolsFailed > 0) {
    return 0.4; // Partial tool failure
  }

  if (isPriceDataMissing || hasErrors) {
    return 0.7; // Cost-basis fallback
  }

  return 1.0; // Full market data available
}
