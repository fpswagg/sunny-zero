/**
 * Raw errors from the SDK or providers, in plain words for the owner. Returns undefined when there is
 * nothing better to say than the raw text.
 */
const RULES: [RegExp, (m: RegExpMatchArray, text: string) => string][] = [
  [/ede_diagnostic|stop_reason=tool_use|result_type=user/i, () => 'The run was cut in the middle of a step (stopped, a tool was refused, or Sunny restarted). Nothing broke; send the message again if something was left.'],
  [/session limit|usage limit|weekly limit|hit your (\w+ )?limit|limit reached/i, (_m, t) => {
    const reset = /resets?\s+(?:at\s+|in\s+)?([^.\n()]{2,40})/i.exec(t)?.[1]?.trim();
    return `Claude usage limit reached${reset ? ` (resets ${reset})` : ''}. Switch account with /account, or wait.`;
  }],
  [/overloaded|\b529\b/i, () => 'Claude is overloaded right now. Try again in a minute.'],
  [/rate.?limit|too many requests|\b429\b/i, () => 'Too many requests to the model for now. Try again in a moment.'],
  [/credit balance|insufficient|quota|billing|\b402\b/i, () => 'The model provider is out of credit for this key.'],
  [/prompt is too long|context.{0,20}(length|window|too long)|too many tokens/i, () => 'The conversation got too long for the model. /new starts a fresh one.'],
  [/max(imum)?[ _-]?turns/i, () => 'The agent reached its maximum number of steps for one message.'],
  [/not logged in|please run \/login|login.*expired|invalid api key|authentication|unauthori[sz]ed|\b401\b|\b403\b|forbidden/i, () => 'The login or key for this model was refused (expired or invalid).'],
  [/econnre|etimedout|fetch failed|socket hang up|network|\b50[234]\b/i, () => 'Network problem reaching the model. Try again shortly.'],
  [/model .*not (found|available)|no endpoints/i, () => 'This model is not available from the provider. Pick another with /model.'],
];

export function explainError(text: string): string | undefined {
  for (const [re, say] of RULES) {
    const m = text.match(re);
    if (m) return say(m, text);
  }
  return undefined;
}
