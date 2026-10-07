import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { oauthFlow, PROVIDERS } from '../../auth/oauth2.ts';
import type { AuthFlow } from '../../auth/types.ts';
import type { SecretStore } from '../../secrets/store.ts';
import type { Connector } from '../types.ts';
import { explainWith, oauthCaller } from '../oauth-api.ts';
import { ApiError, RestClient, UNTRUSTED_NOTE, WriteBudget, guard, ok } from '../shared.ts';

export const GMAIL_SECRET_ID = 'google:gmail';
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const explainGmail = explainWith('Gmail', 'Gmail');

const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const header = (m: Json, name: string): string | undefined => (m.payload?.headers as Json[] | undefined)?.find((h) => String(h.name).toLowerCase() === name)?.value;

const htmlToText = (h: string) =>
  h
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Plain-text body of a message: prefers text/plain, falls back to stripped HTML. */
export function bodyText(payload: Json | undefined): string {
  const find = (p: Json | undefined, type: string): string | undefined => {
    if (!p) return undefined;
    if (p.mimeType === type && p.body?.data) return b64(p.body.data);
    for (const c of (p.parts as Json[] | undefined) ?? []) {
      const r = find(c, type);
      if (r) return r;
    }
    return undefined;
  };
  const plain = find(payload, 'text/plain');
  if (plain) return plain.trim();
  const html = find(payload, 'text/html');
  return html ? htmlToText(html) : '';
}

/** RFC 2822 message, base64url. Header values may not contain line breaks (header injection). */
export function buildRaw(o: { to: string[]; cc?: string[]; subject: string; text: string; inReplyTo?: string; references?: string }): string {
  const clean = (v: string) => {
    if (/[\r\n]/.test(v)) throw new ApiError('Line breaks are not allowed in recipients or subject.');
    return v;
  };
  const enc = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v).toString('base64')}?=`);
  const lines = [
    `To: ${o.to.map(clean).join(', ')}`,
    ...(o.cc?.length ? [`Cc: ${o.cc.map(clean).join(', ')}`] : []),
    `Subject: ${enc(clean(o.subject))}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${clean(o.inReplyTo)}`, `References: ${clean(o.references ?? o.inReplyTo)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(o.text).toString('base64').replace(/(.{76})/g, '$1\r\n'),
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

export interface GmailDeps {
  secrets: SecretStore;
  rest?: RestClient;
  fetch?: typeof fetch;
}

/**
 * Gmail through Google OAuth with two scopes only: read and send. No modify/delete scope is
 * requested, so Sunny cannot delete, archive or change mail even if told to. Sending asks the
 * owner and is capped at 10 an hour (Gmail flags bursts). Mail content is data, not instructions.
 */
export function gmailConnector(deps: GmailDeps): Connector {
  const rest = deps.rest ?? new RestClient({ baseUrl: 'https://gmail.googleapis.com/gmail/v1', minGapMs: 150, service: 'Gmail', explain: explainGmail, doFetch: deps.fetch });
  const sends = new WriteBudget(10, 3600_000);
  const call = oauthCaller({ secrets: deps.secrets, secretId: GMAIL_SECRET_ID, provider: PROVIDERS.google!, rest, setupName: 'gmail', fetch: deps.fetch });
  const summary = (m: Json) => ({ id: m.id, threadId: m.threadId, from: header(m, 'from'), to: header(m, 'to'), subject: header(m, 'subject'), date: header(m, 'date'), snippet: m.snippet, unread: (m.labelIds as string[] | undefined)?.includes('UNREAD') });
  const metaQ = '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date';
  const emails = z.array(z.string().email()).min(1).max(10);

  return {
    name: 'gmail',
    description: "The owner's Gmail: search and read mail, list labels; send mail (asks first). Cannot delete or modify mail.",
    mutatingTools: ['send'],
    status: async () => ((await deps.secrets.has(GMAIL_SECRET_ID)) ? { ready: true } : { ready: false, detail: 'not signed in to Google (setup)' }),
    setup: (): AuthFlow =>
      oauthFlow(deps.secrets, {
        provider: PROVIDERS.google!,
        scopes: GMAIL_SCOPES,
        secretId: GMAIL_SECRET_ID,
        title: 'Sign in to Gmail',
        description: 'Agents will read and search your mail, and send mail only after asking you. They cannot delete or change mail. Sending is capped at 10 an hour.',
        fetch: deps.fetch,
      }),
    server: () =>
      createSdkMcpServer({
        name: 'gmail',
        version: '0.1.0',
        alwaysLoad: true,
        tools: [
          tool('profile', 'The mailbox address and totals.', {}, guard(async () => { const p = await call('/users/me/profile'); return ok({ email: p.emailAddress, messages: p.messagesTotal, threads: p.threadsTotal }); })),
          tool('list_labels', 'Labels (Inbox, Sent, custom).', {}, guard(async () => ok(((await call('/users/me/labels')).labels as Json[]).map((l) => ({ id: l.id, name: l.name }))))),
          tool('search', 'Search mail with Gmail syntax (from:, subject:, is:unread, newer_than:7d, has:attachment…). Empty query = latest mail.', { query: z.string().max(300).default(''), limit: z.number().int().min(1).max(25).default(10), label: z.string().optional() }, guard(async ({ query, limit, label }) => {
            const p = new URLSearchParams({ maxResults: String(limit), ...(query ? { q: query } : {}), ...(label ? { labelIds: label } : {}) });
            const list = ((await call(`/users/me/messages?${p}`)).messages as Json[] | undefined) ?? [];
            const items = await Promise.all(list.map((m) => call(`/users/me/messages/${m.id}${metaQ}`)));
            return ok({ note: UNTRUSTED_NOTE, results: items.map(summary) });
          })),
          tool('get_message', 'Full text of one message (attachments are listed, not downloaded).', { id: z.string().min(5).max(40) }, guard(async ({ id }) => {
            const m = await call(`/users/me/messages/${id}?format=full`, { what: 'this message' });
            const attachments: string[] = [];
            const walk = (p: Json) => { if (p.filename) attachments.push(`${p.filename} (${p.mimeType}, ${p.body?.size ?? 0} bytes)`); (p.parts as Json[] | undefined)?.forEach(walk); };
            walk(m.payload ?? {});
            const text = bodyText(m.payload);
            return ok({ note: UNTRUSTED_NOTE, ...summary(m), messageId: header(m, 'message-id'), cc: header(m, 'cc'), body: text.length > 12_000 ? `${text.slice(0, 12_000)}…` : text, attachments });
          })),
          tool('get_thread', 'All messages of a conversation, as text.', { id: z.string().min(5).max(40) }, guard(async ({ id }) => {
            const t = await call(`/users/me/threads/${id}?format=full`, { what: 'this thread' });
            return ok({ note: UNTRUSTED_NOTE, messages: (t.messages as Json[]).slice(-15).map((m) => ({ ...summary(m), body: bodyText(m.payload).slice(0, 4000) })) });
          })),
          tool('send', 'Send an email from the owner\'s address (plain text). To reply in a thread give threadId and the replyToMessageId (the Message-ID header from get_message).', { to: emails, cc: emails.optional(), subject: z.string().min(1).max(300), text: z.string().min(1).max(50_000), threadId: z.string().optional(), replyToMessageId: z.string().optional() }, guard(async ({ to, cc, subject, text, threadId, replyToMessageId }) => {
            const raw = buildRaw({ to, cc, subject, text, inReplyTo: replyToMessageId });
            sends.take('emails');
            const r = await call('/users/me/messages/send', { method: 'POST', body: { raw, ...(threadId ? { threadId } : {}) }, what: 'sending' });
            return ok({ sent: true, id: r.id, threadId: r.threadId });
          })),
        ],
      }),
  };
}
