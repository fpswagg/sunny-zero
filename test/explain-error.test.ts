import { describe, expect, it } from 'vitest';
import { explainError } from '../src/runtime/explain-error.ts';

describe('explainError', () => {
  it('turns raw SDK errors into plain words', () => {
    expect(explainError('[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use')).toMatch(/cut in the middle/);
    expect(explainError("You've hit your session limit · resets 7pm (Africa/Lagos)")).toMatch(/limit reached \(resets 7pm/);
    expect(explainError('API Error: 529 overloaded')).toMatch(/overloaded/);
    expect(explainError('Prompt is too long')).toMatch(/\/new/);
    expect(explainError('something nobody planned')).toBeUndefined();
  });
});
