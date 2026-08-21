export type FailureClass = 'availability' | 'authentication' | 'policy' | 'invalid_output' | 'grounding' | 'validation' | 'unknown';

export function classifyFailure(_input: { code?: string; message?: string }): FailureClass {
  const value = `${_input.code ?? ''} ${_input.message ?? ''}`.toLowerCase();
  if (/unauthorized|authentication|invalid api key|oauth|forbidden credential/.test(value)) return 'authentication';
  if (/policy_denied|not allowed|policy violation/.test(value)) return 'policy';
  if (/invalid_output|schema mismatch|malformed output/.test(value)) return 'invalid_output';
  if (/grounding_failed|citation missing|ungrounded/.test(value)) return 'grounding';
  if (/validation_failed|tests? failed|lint failed|build failed/.test(value)) return 'validation';
  if (/etimedout|econnreset|rate_limited|service_unavailable|model_unavailable|timed out/.test(value)) {
    return 'availability';
  }
  return 'unknown';
}

export function mayFallback(classification: FailureClass): boolean {
  return classification === 'availability';
}
