import { randomBytes } from 'node:crypto';
import type { ApprovalRequest } from '../runtime/runner.ts';
import type { Outbound } from './types.ts';

interface Pending {
  id: string;
  /** Conversation whose turn asked. */
  origin: string;
  /** Conversations that see the prompt and may answer it (the owner's). */
  targets: string[];
  alwaysKey?: string;
  resolve: (ok: boolean) => void;
  timer: NodeJS.Timeout;
}

/**
 * Approval prompts. By default the conversation that asked answers; turns run for a guest or
 * in the background send theirs to the owner's chats instead.
 */
export class Approvals {
  private pending = new Map<string, Pending>();

  constructor(
    private readonly send: (conversationId: string, event: Outbound) => void,
    private readonly timeoutMs: number,
    /** Remembers "always allow" answers, by the request's alwaysKey. */
    private readonly memory?: { has(key: string): Promise<boolean>; add(key: string): Promise<void> },
  ) {}

  async ask(origin: string, req: ApprovalRequest, targets: string[] = [origin]): Promise<boolean> {
    if (req.alwaysKey && (await this.memory?.has(req.alwaysKey).catch(() => false))) return true;
    const id = randomBytes(6).toString('hex');
    const expiresAt = Date.now() + this.timeoutMs;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.close(id, false, 'timeout'), this.timeoutMs);
      const alwaysKey = this.memory ? req.alwaysKey : undefined;
      this.pending.set(id, { id, origin, targets, alwaysKey, resolve, timer });
      for (const target of targets) this.send(target, { type: 'approval', id, agent: req.agent, summary: req.summary, reason: req.reason, expiresAt, always: !!alwaysKey });
    });
  }

  /** Answer from a client. Ignored unless the conversation was asked. */
  answer(conversationId: string, id: string, allowed: boolean, always = false): boolean {
    const p = this.pending.get(id);
    if (!p || !p.targets.includes(conversationId)) return false;
    const remembered = allowed && always && !!p.alwaysKey;
    if (remembered) void this.memory?.add(p.alwaysKey!).catch(() => undefined);
    this.close(id, allowed, 'user', remembered);
    return true;
  }

  /** The most recent open approval shown in a conversation (for plain "yes"/"no" replies). */
  latest(conversationId: string): string | undefined {
    let last: string | undefined;
    for (const p of this.pending.values()) if (p.targets.includes(conversationId)) last = p.id;
    return last;
  }

  /** Denies what a conversation's own turns asked (on /stop). */
  cancelAll(origin: string): void {
    for (const p of [...this.pending.values()]) if (p.origin === origin) this.close(p.id, false, 'cancelled');
  }

  private close(id: string, allowed: boolean, by: 'user' | 'timeout' | 'cancelled', always = false): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    for (const target of p.targets) this.send(target, { type: 'approval_closed', id, allowed, by, always });
    p.resolve(allowed);
  }
}
