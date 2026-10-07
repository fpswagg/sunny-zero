import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { Channel, Outbound } from '../gateway/types.ts';
import type { Gateway } from '../gateway/gateway.ts';
import { log } from '../log.ts';

/** Client → daemon messages on /ws. */
export const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), token: z.string(), channel: z.enum(['cli', 'web']), conversation: z.string().regex(/^[\w.-]{1,64}$/).default('default') }),
  z.object({ type: z.literal('message'), text: z.string().max(100_000) }),
  z.object({ type: z.literal('approve'), id: z.string(), allow: z.boolean() }),
  /** Credentials typed in the terminal (`sunny setup telegram`); handled by the daemon, never shown to agents. */
  z.object({ type: z.literal('setup'), service: z.literal('telegram'), token: z.string().max(200), bot: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/).optional() }),
]);

/** Daemon → client messages. */
export type ServerMessage = { type: 'ready'; conversationId: string; agent: string } | { type: 'event'; event: Outbound } | { type: 'fatal'; error: string };

/**
 * Terminal and browser clients talk to the daemon over one WebSocket protocol. Several clients
 * can share a conversation (e.g. the same chat open in the terminal and the browser).
 */
export class SocketChannel implements Channel {
  private subscribers = new Map<string, Set<WebSocket>>();

  constructor(readonly id: 'cli' | 'web') {}

  send(conversationId: string, event: Outbound): void {
    for (const ws of this.subscribers.get(conversationId) ?? []) sendTo(ws, { type: 'event', event });
  }

  /** Conversations with a client connected right now. */
  async homes(_agent?: string): Promise<string[]> {
    return [...this.subscribers.keys()];
  }

  attach(conversationId: string, ws: WebSocket): void {
    const set = this.subscribers.get(conversationId) ?? new Set();
    set.add(ws);
    this.subscribers.set(conversationId, set);
    ws.on('close', () => {
      set.delete(ws);
      if (!set.size) this.subscribers.delete(conversationId);
    });
  }
}

export function sendTo(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** Handles one WebSocket connection: authenticate with hello, then relay messages. */
export function handleSocket(ws: WebSocket, gateway: Gateway, channels: Record<'cli' | 'web', SocketChannel>, checkToken: (token: string) => boolean): void {
  let conversationId: string | undefined;
  const helloTimer = setTimeout(() => ws.close(4001, 'hello timeout'), 10_000);

  ws.on('message', async (data) => {
    let msg: z.infer<typeof clientMessage>;
    try {
      msg = clientMessage.parse(JSON.parse(data.toString()));
    } catch {
      sendTo(ws, { type: 'fatal', error: 'bad message' });
      return;
    }

    if (msg.type === 'hello') {
      clearTimeout(helloTimer);
      if (!checkToken(msg.token)) {
        sendTo(ws, { type: 'fatal', error: 'invalid token' });
        ws.close(4003, 'invalid token');
        return;
      }
      conversationId = `${msg.channel}:${msg.conversation}`;
      channels[msg.channel].attach(conversationId, ws);
      sendTo(ws, { type: 'ready', conversationId, agent: await gateway.currentAgent(conversationId) });
      return;
    }

    if (!conversationId) {
      ws.close(4001, 'say hello first');
      return;
    }
    if (msg.type === 'message') {
      gateway.handleMessage(conversationId, msg.text).catch((err) => log.error({ err }, 'message failed'));
    } else if (msg.type === 'setup') {
      await gateway.setTelegramToken(conversationId, msg.token, msg.bot);
    } else {
      gateway.answerApproval(conversationId, msg.id, msg.allow);
    }
  });
}
