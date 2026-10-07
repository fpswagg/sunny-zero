import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ApprovalRequest, RunResult } from '../runtime/runner.ts';

export interface AskAgentDeps {
  /** The agent that asks. */
  from: string;
  /** Names of the agents it may ask (enabled, not itself, not Sunny). */
  others(): { name: string; description: string }[];
  /** Asks the owner yes/no in the chat; resolves false when refused. */
  approve(req: ApprovalRequest): Promise<boolean>;
  run(name: string, message: string): Promise<RunResult>;
}

/** Lets an agent send a message to another agent, once the owner has said yes to that exact request. */
export function askAgentServer(deps: AskAgentDeps): McpSdkServerConfigWithInstance {
  const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError });
  return createSdkMcpServer({
    name: 'agents',
    version: '0.1.0',
    alwaysLoad: true,
    tools: [
      tool('list_agents', 'The other agents you can ask for help, with what each does.', {}, async () => {
        const list = deps.others();
        return text(list.length ? list.map((a) => `- ${a.name}: ${a.description}`).join('\n') : 'No other agent is available.');
      }),
      tool(
        'ask_agent',
        'Send a message to another agent and get its reply (e.g. ask a developer agent to build something). The other agent works in its own chat with the owner; its reply comes back to you here. The owner approves first (unless they chose "always allow" for you two), so say clearly what you want and why. If they refuse, do not retry; tell them. Calls to the same agent are spaced by a short cooldown, so batch your questions.',
        { name: z.string(), message: z.string().min(1).max(20_000) },
        async ({ name, message }) => {
          const target = deps.others().find((a) => a.name === name);
          if (!target) return text(`You cannot ask "${name}". Available: ${deps.others().map((a) => a.name).join(', ') || 'none'}.`, true);
          const short = message.length > 300 ? `${message.slice(0, 300)}…` : message;
          const ok = await deps.approve({ agent: deps.from, tool: 'ask_agent', summary: `${deps.from} wants to ask ${name}`, reason: short, alwaysKey: `agent-call:${deps.from}>${name}` });
          if (!ok) return text('The owner said no. Do not ask again; tell them what you wanted.', true);
          const result = await deps.run(name, message);
          return result.isError ? text(`${name} failed: ${result.text}`, true) : text(`${name} replied:\n${result.text}`);
        },
      ),
    ],
  });
}
