import WebSocket from 'ws';
import type { Outbound } from '../gateway/types.ts';
import type { ServerMessage } from '../server/socket-channel.ts';

export interface ClientOptions {
  url: string;
  token: string;
  channel: 'cli' | 'web';
  conversation: string;
  onEvent(event: Outbound): void;
  onClose?(reason: string): void;
}

/** Minimal client for the daemon's /ws protocol. */
export class SocketClient {
  private ws!: WebSocket;
  conversationId = '';
  agent = 'sunny';

  constructor(private readonly opts: ClientOptions) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.opts.url);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ type: 'hello', token: this.opts.token, channel: this.opts.channel, conversation: this.opts.conversation }));
      });
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as ServerMessage;
        if (msg.type === 'ready') {
          this.conversationId = msg.conversationId;
          this.agent = msg.agent;
          resolve();
        } else if (msg.type === 'fatal') {
          reject(new Error(msg.error));
        } else {
          this.opts.onEvent(msg.event);
        }
      });
      this.ws.on('error', reject);
      this.ws.on('close', (_code, reason) => this.opts.onClose?.(reason.toString() || 'connection closed'));
    });
  }

  say(text: string): void {
    this.ws.send(JSON.stringify({ type: 'message', text }));
  }

  setupTelegram(token: string, bot?: string): void {
    this.ws.send(JSON.stringify({ type: 'setup', service: 'telegram', token, bot }));
  }

  approve(id: string, allow: boolean): void {
    this.ws.send(JSON.stringify({ type: 'approve', id, allow }));
  }

  close(): void {
    this.ws.close();
  }
}
