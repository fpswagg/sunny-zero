export interface Field {
  name: string;
  label: string;
  type?: 'text' | 'password' | 'email' | 'number' | 'url' | 'tel' | 'textarea';
  /** Rendered as a password input and never echoed back. Defaults to true for type "password". */
  secret?: boolean;
  optional?: boolean;
  help?: string;
  placeholder?: string;
  /** Prefill for non-secret fields (e.g. after a failed attempt). */
  value?: string;
}

export interface Link {
  label: string;
  url: string;
}

/** What the auth page shows. Each flow moves the page from screen to screen. */
export type Screen =
  | { kind: 'form'; title: string; description?: string; fields: Field[]; submitLabel?: string; error?: string; links?: Link[] }
  | { kind: 'redirect'; title: string; description?: string; url: string; buttonLabel: string; error?: string }
  | { kind: 'done'; title: string; message: string }
  | { kind: 'failed'; title: string; message: string };

export interface FlowContext {
  /** The link token; OAuth flows use it as the `state` parameter. */
  token: string;
  /** Absolute URL providers redirect back to after OAuth consent. */
  oauthRedirectUri: string;
}

/**
 * A credential collection flow. Connectors adapt it to what they need: one form, a sequence
 * of steps (phone → code → 2FA password), or a provider's own OAuth consent screen.
 */
export interface AuthFlow {
  /** Short name shown in chat with the link, e.g. "Sign in to Gmail". */
  title: string;
  start(ctx: FlowContext): Promise<Screen>;
  submit(values: Record<string, string>, ctx: FlowContext): Promise<Screen>;
  /** Called when an OAuth provider redirects back with this flow's state. */
  callback?(params: URLSearchParams, ctx: FlowContext): Promise<Screen>;
}
