import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { RateLimiter } from '../util/rate-limit.ts';
import type { Sql } from '../db/db.ts';
import type { Connector } from './types.ts';

export interface NotifyDeps {
  /** Delivers to the agent's notify targets and returns the conversations reached. */
  deliver(agent: string, targets: string[], text: string, silent: boolean): Promise<string[]>;
  sql: Sql;
}

/**
 * Lets an agent message the user outside the current chat: background workers report results,
 * watchers raise alerts. Where it goes is set by the agent's `notify` field, not by the agent.
 * Every notification is stored in the notifications table, delivered or not.
 */
export function notifyConnector(deps: NotifyDeps): Connector {
  // A looping or manipulated agent must not be able to flood the user's phone.
  const limiter = new RateLimiter([
    { windowMs: 60_000, max: 10 },
    { windowMs: 60 * 60_000, max: 60 },
  ]);

  return {
    name: 'notify',
    description: "Send the user a notification (their paired Telegram chat, or open terminal/web chats). Targets come from the agent's `notify` field.",
    status: async () => ({ ready: true }),
    server: (ctx) =>
      createSdkMcpServer({
        name: 'notify',
        version: '0.1.0',
        alwaysLoad: true,
        tools: [
          tool(
            'send',
            'Send the user a notification. Use it for results, alerts and anything they should see even when they are not chatting with you. Keep it short and self-contained (Markdown is fine). Combine related updates into one message.',
            {
              text: z.string().min(1).max(3500),
              silent: z.boolean().optional().describe('Deliver without sound, for low-priority updates such as digests'),
            },
            async ({ text, silent = false }) => {
              const agent = ctx.agent.name;
              if (!limiter.take(agent)) {
                return { content: [{ type: 'text', text: 'Not sent: too many notifications in a short time. Combine updates into one message.' }], isError: true };
              }
              const delivered = await deps.deliver(agent, ctx.agent.notify, text, silent);
              await deps.sql`
                insert into notifications (agent, conversation, silent, delivered, text)
                values (${agent}, ${ctx.conversationId}, ${silent}, ${delivered}, ${text})`;
              const result = delivered.length
                ? `Delivered to ${delivered.join(', ')}.`
                : 'No channel could be reached right now (Telegram is not paired and no terminal or web chat is open). It was saved to the notification log.';
              return { content: [{ type: 'text', text: result }] };
            },
          ),
        ],
      }),
  };
}
