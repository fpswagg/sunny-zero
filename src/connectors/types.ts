import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { AgentDefinition } from '../agents/schema.ts';
import type { AuthFlow } from '../auth/types.ts';
import type { Speaker } from '../users/users.ts';

export interface ConnectorContext {
  agent: AgentDefinition;
  conversationId: string;
  speaker: Speaker;
}

export interface ConnectorStatus {
  ready: boolean;
  /** What is missing when not ready, e.g. "not signed in". */
  detail?: string;
}

/** Something that happened, for agents with a matching event trigger. */
export interface ConnectorEvent {
  /** Connector name, e.g. "vps". */
  source: string;
  /** e.g. "alert", "resolved". */
  name: string;
  /** One line for logs and lists. */
  summary: string;
  data: Record<string, unknown>;
}

/** Given to connectors that watch something in the background. */
export interface ConnectorRuntime {
  emit(event: ConnectorEvent): void;
  /** Tells the owner something directly (setup problems, lost credentials). */
  notifyOwner(text: string): void;
}

/**
 * An integration exposed to agents as an MCP server. Credentials stay inside the connector;
 * agents only see its tools.
 */
export interface Connector {
  name: string;
  description: string;
  /** Tools (bare names) that change something. They ask the owner unless the agent auto-approves them. */
  mutatingTools?: string[];
  status(): Promise<ConnectorStatus>;
  server(ctx: ConnectorContext): McpServerConfig;
  /** The page that collects what the connector needs (credentials, settings). */
  setup?(): Promise<AuthFlow> | AuthFlow;
  /** Starts background work (polling, watching) with the daemon. */
  start?(runtime: ConnectorRuntime): Promise<void>;
  stop?(): Promise<void>;
}

export class ConnectorRegistry {
  private connectors = new Map<string, Connector>();

  register(connector: Connector): void {
    this.connectors.set(connector.name, connector);
  }

  get(name: string): Connector | undefined {
    return this.connectors.get(name);
  }

  list(): Connector[] {
    return [...this.connectors.values()];
  }

  /** True for a connector tool ("mcp__vps__restart") its connector marks as changing something. */
  isMutating(tool: string): boolean {
    const m = /^mcp__([\w-]+?)__(.+)$/.exec(tool);
    if (!m) return false;
    return this.connectors.get(m[1]!)?.mutatingTools?.includes(m[2]!) ?? false;
  }

  /** MCP servers for an agent's connectors; unknown names are reported, not fatal. */
  serversFor(ctx: ConnectorContext): { servers: Record<string, McpServerConfig>; missing: string[] } {
    const servers: Record<string, McpServerConfig> = {};
    const missing: string[] = [];
    for (const name of ctx.agent.connectors) {
      const connector = this.connectors.get(name);
      if (connector) servers[name] = connector.server(ctx);
      else missing.push(name);
    }
    return { servers, missing };
  }
}
