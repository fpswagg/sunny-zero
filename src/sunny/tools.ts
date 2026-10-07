import { startCodexLogin } from '../providers/codex.ts';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { agentSchema, accessSchema, memorySchema, privilegedReasons, type AgentDefinition, type AgentInput } from '../agents/schema.ts';
import type { AgentRegistry } from '../agents/registry.ts';
import { saveIcon } from '../agents/icons.ts';
import type { ConnectorRegistry } from '../connectors/types.ts';
import type { SecretStore } from '../secrets/store.ts';
import type { AuthFlow } from '../auth/types.ts';
import { formFlow } from '../auth/flows.ts';
import { oauthFlow, PROVIDERS } from '../auth/oauth2.ts';
import type { ApprovalRequest, RunResult } from '../runtime/runner.ts';
import type { TelegramControl } from '../gateway/types.ts';
import { isInside } from '../runtime/policy.ts';
import { ensureDirs, problems } from '../agents/validate.ts';

export { problems };
import { OWNER_ID, USER_ID, type UserStore } from '../users/users.ts';
import { EFFORTS, formatModelRef, isProviderId, PROVIDER_IDS, PROVIDERS as MODEL_PROVIDERS } from '../providers/catalog.ts';
import type { Providers } from '../providers/providers.ts';
import { ManageError, type AgentManager } from '../manage/manager.ts';

/** What Sunny's tools need from the daemon, bound to the conversation Sunny is answering. */
export interface SunnyDeps {
  registry: AgentRegistry;
  connectors: ConnectorRegistry;
  secrets: SecretStore;
  users: UserStore;
  conversationId: string;
  approve(req: ApprovalRequest): Promise<boolean>;
  runAgent(name: string, message: string): Promise<RunResult>;
  /** Creates a one-time auth link and sends it to the owner's conversation. */
  sendAuthLink(flow: AuthFlow): void;
  forgetSessions(agent: string): Promise<void>;
  recentRuns(agent: string, limit: number): Promise<unknown[]>;
  recentEvents(hours: number, source?: string): Promise<unknown[]>;
  /** Next runs of an agent's schedules. */
  upcoming(agent: string): { schedule: string; next: Date | null }[];
  timezone: string;
  telegram?: TelegramControl;
  /** Sunny's inbox: files the owner sent it, which run_agent can pass on. */
  inboxDir?: string;
  manager: AgentManager;
  providers: Providers;
}

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

const SECRET_ID = /^[a-z0-9][a-z0-9:_.-]{1,63}$/;

const defShape = agentSchema.omit({ createdAt: true, updatedAt: true }).shape;
const changesSchema = agentSchema
  .omit({ name: true, createdAt: true, updatedAt: true })
  .extend({ access: accessSchema.partial(), memory: memorySchema.partial() })
  .partial();
const iconField = z.string().optional().describe('Square SVG icon (viewBox="0 0 512 512") that looks like the agent\'s name; shown as its Telegram picture');

export function sunnyServer(deps: SunnyDeps): McpSdkServerConfigWithInstance {
  const { registry, users } = deps;

  const summarize = (def: AgentDefinition) => {
    const triggers = def.triggers.map((t) =>
      t.type === 'cron' ? `cron "${t.schedule}" (${t.timezone ?? deps.timezone})` : t.type === 'event' ? `event ${t.source}:${t.on}${t.filter ? ` ${JSON.stringify(t.filter)}` : ''}` : 'manual',
    );
    const next = deps.upcoming(def.name).filter((u) => u.next);
    const a = def.access;
    return [
      `**${def.name}**: ${def.description}`,
      `- model: ${formatModelRef(def.provider, def.model)}${def.effort ? ` (effort ${def.effort})` : ''}${def.fallbackModels.length ? ` · fallbacks: ${def.fallbackModels.join(' → ')}` : ''} · tools: ${def.tools.join(', ') || 'none'} · connectors: ${def.connectors.join(', ') || 'none'}`,
      `- triggers: ${triggers.join(', ')}${next.length ? ` · next run ${next.map((u) => u.next!.toISOString()).join(', ')}` : ''}`,
      `- access: ${a.profile}${a.workdir ? ` (${a.workdir})` : ''}${a.readOnlyDirs.length ? ` · reads ${a.readOnlyDirs.join(', ')}` : ''}${a.writableFiles.length ? ` · writes ${a.writableFiles.join(', ')} there` : ''}${a.commands.length ? ` · commands ${a.commands.join(' · ')}` : ''}${a.autoApprove.length ? ` · auto-approve ${a.autoApprove.join(', ')}` : ''}`,
      `- memory: session ${def.memory.session}${def.memory.notes ? ' + notes' : ''} · notify: ${def.notify.join(', ') || 'default'}${def.enabled ? '' : ' · DISABLED'}`,
    ].join('\n');
  };

  const connectorNote = (def: AgentDefinition) => {
    const unknown = def.connectors.filter((c) => !deps.connectors.get(c));
    const sources = def.triggers.flatMap((t) => (t.type === 'event' && !deps.connectors.get(t.source) ? [t.source] : []));
    return [
      unknown.length ? `\nNote: connectors not installed: ${unknown.join(', ')}. The agent runs without them.` : '',
      sources.length ? `\nNote: no connector emits "${sources.join(', ')}" events yet.` : '',
    ].join('');
  };

  const validate = (def: AgentDefinition) => problems(def, deps.timezone);

  return createSdkMcpServer({
    name: 'sunny',
    version: '0.2.0',
    alwaysLoad: true,
    tools: [
      tool('list_agents', 'List every agent with its purpose, tools, triggers (and next scheduled run), access, memory and notification settings.', {}, async () => {
        const agents = registry.list();
        return ok(agents.length ? agents.map((a) => summarize(a.def)).join('\n\n') : 'No agents yet.');
      }),

      tool('get_agent', "Show an agent's full definition (agent.json) and system prompt.", { name: z.string() }, async ({ name }) => {
        const agent = registry.get(name);
        if (!agent) return fail(`No agent named "${name}".`);
        return ok(`agent.json:\n${JSON.stringify(agent.def, null, 2)}\n\nprompt.md:\n${agent.prompt}`);
      }),

      tool(
        'create_agent',
        'Create a new agent with a complete system prompt and an icon that looks like its name. Grant the least access that does the job: anything beyond a restricted agent (folders, read-only folders, allowed commands, full access, auto-approved tools) asks the owner first.',
        { ...defShape, prompt: z.string().min(1).describe("The agent's system prompt (Markdown)"), icon: iconField },
        async ({ prompt, icon, ...input }) => {
          if (input.name === 'sunny') return fail('"sunny" is reserved.');
          if (registry.get(input.name)) return fail(`"${input.name}" already exists; use update_agent.`);
          let def: AgentDefinition;
          try {
            if (input.provider || input.model) {
              const { provider, model } = await deps.manager.resolveModel(formatModelRef(input.provider, input.model ?? ''));
              Object.assign(input, { provider: provider === 'claude' ? undefined : provider, model });
            } else {
              const fallback = await deps.manager.savedDefaultModel();
              if (fallback) Object.assign(input, { provider: fallback.provider === 'claude' ? undefined : fallback.provider, model: fallback.model, effort: input.effort ?? fallback.effort });
            }
            def = registry.parse(input as AgentInput);
          } catch (err) {
            return fail(err instanceof ManageError ? err.message : `Invalid definition: ${(err as Error).message}`);
          }
          const issues = validate(def);
          if (issues.length) return fail(issues.join('\n'));
          const reasons = privilegedReasons(def);
          if (reasons.length) {
            const approved = await deps.approve({ agent: 'sunny', tool: 'create_agent', summary: `Create agent "${def.name}"`, reason: reasons.join('; ') });
            if (!approved) return fail('The owner did not approve this access. Ask what they would accept, or create it with less access.');
          }
          await ensureDirs(def);
          const agent = await registry.save(def, prompt);
          const iconProblem = icon ? await saveIcon(agent.dir, icon) : 'no icon given';
          const iconNote = iconProblem ? `\nIcon not saved (${iconProblem}). Draw one with set_agent_icon.` : '';
          return ok(`Created.\n${summarize(agent.def)}${connectorNote(agent.def)}${iconNote}`);
        },
      ),

      tool(
        'update_agent',
        "Change an agent's settings and/or prompt. `changes` holds only the fields to change (access and memory are merged). New privileges ask the owner first.",
        {
          name: z.string(),
          changes: changesSchema.optional(),
          prompt: z.string().optional().describe('Replacement system prompt'),
        },
        async ({ name, changes, prompt }) => {
          const agent = registry.get(name);
          if (!agent) return fail(`No agent named "${name}".`);
          try {
            if (changes && (changes.provider !== undefined || changes.model !== undefined)) {
              const { provider, model } = await deps.manager.resolveModel(formatModelRef(changes.provider ?? agent.def.provider, changes.model ?? agent.def.model ?? ''));
              changes = { ...changes, provider: provider === 'claude' ? undefined : provider, model };
            }
            if (changes?.fallbackModels?.length) {
              const refs: string[] = [];
              for (const ref of changes.fallbackModels) {
                const r = await deps.manager.resolveModel(ref);
                refs.push(formatModelRef(r.provider, r.model));
              }
              changes = { ...changes, fallbackModels: refs };
            }
            const saved = await deps.manager.update(name, changes as never, prompt, (summary, reasons) =>
              deps.approve({ agent: 'sunny', tool: 'update_agent', summary, reason: reasons.join('; ') }),
            );
            return ok(`Updated.\n${summarize(saved.def)}${connectorNote(saved.def)}`);
          } catch (err) {
            if (err instanceof ManageError) return fail(err.message);
            throw err;
          }
        },
      ),

      tool(
        'set_agent_icon',
        "Set an agent's icon: a square SVG (viewBox 0 0 512 512) that clearly looks like its name, bold and readable at small sizes and when cropped to a circle. Shapes and gradients only: no text, scripts or external images. Updates its Telegram bot picture too.",
        { name: z.string(), svg: z.string() },
        async ({ name, svg }) => {
          const agent = registry.get(name);
          if (!agent) return fail(`No agent named "${name}".`);
          const problem = await saveIcon(agent.dir, svg);
          if (problem) return fail(`Icon not saved: ${problem}`);
          await deps.telegram?.refreshProfile(name).catch(() => {});
          return ok(`Saved ${name}'s icon.`);
        },
      ),

      tool(
        'set_agent_color',
        "Set an agent's accent colour (hex like #e13c46) used in its app and the manager, or \"auto\" to take it from its icon again.",
        { name: z.string(), color: z.string().regex(/^(#[0-9a-fA-F]{6}|auto)$/) },
        async ({ name, color }) => {
          const agent = registry.get(name);
          if (!agent) return fail(`No agent named "${name}".`);
          try {
            await deps.manager.update(name, { color: color === 'auto' ? undefined : color }, undefined, async () => true);
            return ok(`${name}'s colour is ${color}.`);
          } catch (err) {
            if (err instanceof ManageError) return fail(err.message);
            throw err;
          }
        },
      ),

      tool(
        'budgets',
        'Daily spend limits per agent. action list: budgets and what each agent spent today. action set: `agent` (name or "all" for the default), `dailyUsd`, and `block` (true: the agent stops at the limit until tomorrow; false: only alerts the owner at 80% and 100%). action remove: delete that budget.',
        { action: z.enum(['list', 'set', 'remove']).default('list'), agent: z.string().optional(), dailyUsd: z.number().positive().optional(), block: z.boolean().default(false) },
        async ({ action, agent, dailyUsd, block }) => {
          try {
            if (action === 'list') {
              const b = await deps.manager.budgets();
              return ok(Object.entries(b).map(([n, v]) => `- ${n === '*' ? 'default' : n}: ${v?.dailyUsd ? `$${v.dailyUsd}/day, ${v.block ? 'blocks' : 'alerts'}` : 'no budget'}${n === '*' ? '' : `, spent today $${(v?.spent ?? 0).toFixed(2)}`}`).join('\n'));
            }
            if (!agent) return fail('Name the agent (or "all").');
            if (action === 'set' && !dailyUsd) return fail('Give dailyUsd.');
            return ok(await deps.manager.setBudget(agent, action === 'remove' ? null : dailyUsd!, block));
          } catch (err) {
            if (err instanceof ManageError) return fail(err.message);
            throw err;
          }
        },
      ),

      tool(
        'quiet_mode',
        'Quiet hours: notifications reach the owner without sound between `from` and `to` (HH:MM, the owner\'s time zone; may cross midnight). Approvals still ring. Call with no arguments to read the setting.',
        { enabled: z.boolean().optional(), from: z.string().optional(), to: z.string().optional() },
        async (q) => {
          try {
            const r = Object.keys(q).length ? await deps.manager.setQuiet(q) : deps.manager.quiet();
            return ok(`Quiet mode ${r.enabled ? 'on' : 'off'}: ${r.from}–${r.to} (${deps.timezone}).`);
          } catch (err) {
            if (err instanceof ManageError) return fail(err.message);
            throw err;
          }
        },
      ),

      tool(
        'backups',
        'Backups of the agents (definitions, prompts, notes and Sunny settings; no secrets or chats): a daily archive, last 14 kept. action status: the last one. action now: make one.',
        { action: z.enum(['status', 'now']).default('status') },
        async ({ action }) => {
          try {
            if (action === 'now') {
              const b = await deps.manager.backupNow();
              return ok(`Backup made: ${b.name} (${Math.round(b.size / 1024)} KB).`);
            }
            const s = await deps.manager.backupState();
            return ok(s.last ? `${s.count} kept. Last: ${s.last.name}, ${s.last.at.toISOString()}.` : 'No backup yet.');
          } catch (err) {
            if (err instanceof ManageError) return fail(err.message);
            throw err;
          }
        },
      ),

      tool(
        'activity_log',
        'Recent model fallback switches (when and why a model failed) and agent-to-agent calls (who asked what of whom).',
        { kind: z.enum(['fallback', 'agent_call']).optional(), limit: z.number().int().min(1).max(50).default(15) },
        async ({ kind, limit }) => {
          const rows = await deps.manager.activity({ kind, limit });
          if (!rows.length) return ok('Nothing yet.');
          return ok(rows.map((r) => `- ${r.at.toISOString()} ${r.kind === 'fallback' ? `fallback ${r.agent}: ${r.other}` : `${r.agent} → ${r.other}${r.ok ? '' : ' (failed)'}`}: ${r.detail.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n'));
        },
      ),

      tool(
        'agent_prefs',
        'Telegram console card and light voice model: set for one agent (`agent`), or for everyone (`agent` = "all", console only). `console`/`voiceLight`: true, false, or null to follow the global switch. Also `fallbacks`: models tried in order when the main one fails (e.g. ["kimi:kimi-k2.7-code"]).',
        { agent: z.string(), console: z.boolean().nullable().optional(), voiceLight: z.boolean().nullable().optional(), fallbacks: z.array(z.string()).max(5).optional() },
        async ({ agent, console: con, voiceLight, fallbacks }) => {
          try {
            const out: string[] = [];
            if (agent === 'all') {
              if (typeof con === 'boolean') await deps.manager.setConsole(con);
              out.push(`Console card everywhere: ${deps.manager.consoleGlobal() ? 'on' : 'off'}.`);
            } else {
              if (con !== undefined || voiceLight !== undefined) await deps.manager.setAgentPrefs(agent, { console: con, voiceLight });
              if (fallbacks) out.push(await deps.manager.setFallbacks(agent, fallbacks));
              out.push(`${agent}: console ${JSON.stringify(deps.manager.consoleState(agent).own ?? 'follows global')}.`);
            }
            return ok(out.join(' '));
          } catch (err) {
            if (err instanceof ManageError) return fail(err.message);
            throw err;
          }
        },
      ),

      tool('delete_agent', 'Delete an agent (moved to the trash with its memory), its Telegram bot and the access given to it. Asks the owner first.', { name: z.string() }, async ({ name }) => {
        if (!registry.get(name)) return fail(`No agent named "${name}".`);
        const approved = await deps.approve({ agent: 'sunny', tool: 'delete_agent', summary: `Delete agent "${name}"`, reason: 'removes the agent, its bot and its guests’ access (files kept in data/trash)' });
        if (!approved) return fail('The owner kept the agent.');
        await deps.telegram?.removeBot(name);
        await users.revokeAgent(name);
        await registry.delete(name);
        await deps.forgetSessions(name);
        return ok(`Deleted "${name}".`);
      }),

      tool(
        'run_agent',
        "Send a message to an agent and get its reply. Use it to delegate, or to test an agent you just created. The agent's tool calls and approvals show up in the owner's chat.",
        {
          name: z.string(),
          message: z.string().min(1),
          files: z.array(z.string()).max(20).optional().describe("Files from your inbox (ones the owner sent you) to pass on; they are copied to the agent's inbox"),
        },
        async ({ name, message, files = [] }) => {
          const agent = registry.get(name);
          if (!agent) return fail(`No agent named "${name}".`);
          if (!agent.def.enabled) return fail(`"${name}" is disabled.`);
          const copied: string[] = [];
          for (const file of files) {
            const from = resolve(file);
            if (!deps.inboxDir || !isInside(from, deps.inboxDir) || !existsSync(from)) return fail(`${file} is not a file in your inbox (${deps.inboxDir ?? 'none'}).`);
            const dir = join(agent.dir, 'inbox', new Date().toISOString().slice(0, 10));
            await mkdir(dir, { recursive: true });
            let dest = join(dir, basename(from));
            for (let i = 2; existsSync(dest); i++) dest = join(dir, `${basename(from, extname(from))}-${i}${extname(from)}`);
            await copyFile(from, dest);
            copied.push(dest);
          }
          const full = copied.length ? `${message}\n\nFiles the owner sent (copied to your inbox):\n${copied.map((f) => `- ${f}`).join('\n')}` : message;
          const result = await deps.runAgent(name, full);
          return result.isError ? fail(`${name} failed: ${result.text}`) : ok(`${name} replied:\n${result.text}`);
        },
      ),

      tool('agent_runs', 'Recent runs of an agent from its log: when, what started it (message, sunny, cron, event), the message, the reply, errors and cost.', { name: z.string(), limit: z.number().int().min(1).max(50).default(10) }, async ({ name, limit }) => {
        const runs = await deps.recentRuns(name, limit);
        return ok(runs.length ? JSON.stringify(runs, null, 2) : `No runs logged for "${name}".`);
      }),

      tool('recent_events', 'Events connectors emitted (e.g. vps alerts) in the last hours, and which agents they woke.', { hours: z.number().int().min(1).max(720).default(24), source: z.string().optional() }, async ({ hours, source }) => {
        const events = await deps.recentEvents(hours, source);
        return ok(events.length ? JSON.stringify(events, null, 1) : 'No events.');
      }),

      tool('list_connectors', 'List installed connectors (integrations agents can use), whether they are ready, and which of their tools change things.', {}, async () => {
        const list = deps.connectors.list();
        if (!list.length) return ok('No connectors installed yet.');
        const lines = await Promise.all(
          list.map(async (c) => {
            const s = await c.status();
            const state = s.ready ? `ready${s.detail ? ` (${s.detail})` : ''}` : `not ready: ${s.detail ?? 'unknown'}`;
            return `- ${c.name}: ${c.description} [${state}]${c.mutatingTools?.length ? ` · changing tools: ${c.mutatingTools.join(', ')}` : ''}${c.setup ? ' · has setup' : ''}`;
          }),
        );
        return ok(lines.join('\n'));
      }),

      // ── Models and providers ─────────────────────────────────────────────────

      tool(
        'list_providers',
        'Model providers agents can run on (Claude subscription, Claude API, OpenAI/GPT, Gemini, Kimi, OpenRouter): which are connected, which agents use them, and caveats.',
        {},
        async () => {
          const [status, views] = await Promise.all([deps.providers.status(), deps.manager.views()]);
          const fallback = await deps.manager.defaultModel();
          return ok(
            [
              ...status.map((p) => {
                const users = views.filter((v) => v.provider === p.id).map((v) => `${v.name} (${v.model})`);
                return `- ${p.id}: ${p.name} [${p.connected ? 'connected' : 'not connected'}]${users.length ? ` · used by ${users.join(', ')}` : ''}${p.notes ? ` · ${p.notes}` : ''}`;
              }),
              `New agents default to ${formatModelRef(fallback.provider, fallback.model)}${fallback.effort ? ` (effort ${fallback.effort})` : ''}.`,
            ].join('\n'),
          );
        },
      ),

      tool(
        'connect_provider',
        "Send the owner the secure page for a model provider's API key (checked with the provider, stored encrypted; you never see it). Use it before moving an agent to that provider.",
        { provider: z.enum(PROVIDER_IDS.filter((p) => p !== 'claude') as [string, ...string[]]) },
        async ({ provider }) => {
          const id = provider as Exclude<(typeof PROVIDER_IDS)[number], 'claude'>;
          if (id === 'codex') {
            try {
              const login = await startCodexLogin();
              return ok(`ChatGPT sign-in started (no API key needed). Tell the owner: open ${login.url} and enter the code ${login.code} (valid 15 minutes).`);
            } catch (err) {
              return fail((err as Error).message);
            }
          }
          deps.sendAuthLink(deps.providers.keyFlow(id));
          return ok(`The secure page for the ${MODEL_PROVIDERS[id].name} key was sent to the owner. They get a confirmation in chat when it is saved; then list_models works.`);
        },
      ),

      tool('disconnect_provider', "Forget a provider's API key. Agents on it fail until moved. Asks the owner first.", { provider: z.string() }, async ({ provider }) => {
        if (!isProviderId(provider) || provider === 'claude') return fail(`"${provider}" is not a provider with a key.`);
        const users = (await deps.manager.views()).filter((v) => v.provider === provider).map((v) => v.name);
        const approved = await deps.approve({
          agent: 'sunny',
          tool: 'disconnect_provider',
          summary: `Forget the ${MODEL_PROVIDERS[provider].name} key`,
          reason: users.length ? `${users.join(', ')} run on it and will fail` : 'no agent uses it',
        });
        if (!approved) return fail('The owner kept the key.');
        await deps.providers.disconnect(provider);
        return ok(`Forgot the ${MODEL_PROVIDERS[provider].name} key.`);
      }),

      tool(
        'list_models',
        "A connected provider's models (live from the provider; chat models with tool use, suggested first), with context size and price when known.",
        { provider: z.enum(PROVIDER_IDS), search: z.string().optional(), limit: z.number().int().min(1).max(200).default(40) },
        async ({ provider, search, limit }) => {
          try {
            const q = search?.toLowerCase();
            const list = (await deps.providers.listModels(provider)).filter((m) => !q || m.id.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q));
            if (!list.length) return ok('No matching models.');
            return ok(
              list
                .slice(0, limit)
                .map((m) => `- ${formatModelRef(provider, m.id)}${m.suggested ? ' ⭐' : ''}${m.name ? ` (${m.name})` : ''}${m.context ? ` · ${m.context} ctx` : ''}${m.pricing ? ` · $${m.pricing.input.toFixed(2)}/$${m.pricing.output.toFixed(2)} per M tokens` : ''}`)
                .join('\n') + (list.length > limit ? `\n… ${list.length - limit} more` : ''),
            );
          } catch (err) {
            return fail((err as Error).message);
          }
        },
      ),

      tool(
        'set_model',
        'Change the model (and optionally effort) of an agent or of Sunny itself ("sunny"). `model` is "provider:model" (e.g. "openai:gpt-5.5", "gemini:gemini-3.8-flash", "openrouter:moonshotai/kimi-k3", "anthropic:claude-opus-5-5") or a bare Claude model on the subscription ("opus", "sonnet"). The provider must be connected; the model is checked against its list. Suggest test_model afterwards.',
        { name: z.string(), model: z.string(), effort: z.enum([...EFFORTS, 'default']).optional() },
        async ({ name, model, effort }) => {
          try {
            return ok(await deps.manager.setModel(name, model, effort === 'default' ? null : effort));
          } catch (err) {
            if (err instanceof ManageError) return fail(err.message);
            throw err;
          }
        },
      ),

      tool('set_effort', 'Set how hard an agent (or "sunny") thinks: low, medium, high, xhigh, max, or "default" for the model\'s own.', { name: z.string(), effort: z.enum([...EFFORTS, 'default']) }, async ({ name, effort }) => {
        try {
          return ok(await deps.manager.setEffort(name, effort === 'default' ? null : effort));
        } catch (err) {
          if (err instanceof ManageError) return fail(err.message);
          throw err;
        }
      }),

      tool(
        'set_default_model',
        'The model (and effort) new agents get when create_agent names none.',
        { model: z.string(), effort: z.enum([...EFFORTS, 'default']).optional() },
        async ({ model, effort }) => {
          try {
            return ok(await deps.manager.setDefaultModel(model, effort === 'default' ? null : effort));
          } catch (err) {
            if (err instanceof ManageError) return fail(err.message);
            throw err;
          }
        },
      ),

      tool(
        'test_model',
        "Send a one-line prompt through an agent's model (or another \"provider:model\") with no tools, to check the provider, key and model work. Takes a few seconds.",
        { name: z.string(), model: z.string().optional() },
        async ({ name, model }) => {
          try {
            const r = await deps.manager.test(name, model);
            const stats = `${(r.durationMs / 1000).toFixed(1)}s${r.outputTokens !== undefined ? `, ${r.inputTokens ?? 0}→${r.outputTokens} tokens` : ''}${r.costUsd ? `, $${r.costUsd.toFixed(4)}` : ''}`;
            return r.isError ? fail(`${r.modelRef} failed (${stats}): ${r.text}`) : ok(`${r.modelRef} works (${stats}). It said: ${r.text}`);
          } catch (err) {
            if (err instanceof ManageError) return fail(err.message);
            throw err;
          }
        },
      ),

      tool('usage_report', 'Runs, failures, tokens and cost per agent and model over the last days (subscription costs are API-equivalent).', { days: z.number().int().min(1).max(365).default(7) }, async ({ days }) => {
        const rows = await deps.manager.usage(days);
        if (!rows.length) return ok(`No runs in the last ${days} days.`);
        return ok(
          rows
            .map((r) => `- ${r.agent} on ${r.model ?? 'unknown model'}: ${r.runs} runs (${r.errors} failed), ${r.inputTokens} in / ${r.outputTokens} out tokens, $${r.costUsd.toFixed(3)}, last ${r.lastAt.toISOString()}`)
            .join('\n'),
        );
      }),

      tool('usage_limits', "The Claude subscription's limits (session and weekly %, reset times) and what each connected API provider reports (OpenRouter credits, Kimi balance; others have no balance API).", { refresh: z.boolean().default(false) }, async ({ refresh }) => {
        const [sub, accounts] = await Promise.all([deps.manager.subscriptionUsage(refresh), deps.manager.providerAccounts(refresh)]);
        const lines = [`Claude subscription${sub.plan ? ` (${sub.plan})` : ''}: ${sub.ok ? '' : `unavailable: ${sub.error}`}`];
        for (const w of sub.windows) lines.push(`- ${w.label}: ${Math.round(w.percent)}% used, resets ${w.resetsAt ?? 'unknown'}`);
        if (sub.extraUsage) lines.push(`- Extra usage: ${sub.extraUsage.enabled ? `on, ${sub.extraUsage.usedCredits ?? 0} used` : 'off'}`);
        for (const a of accounts.filter((x) => x.connected)) lines.push(`${a.name}: ${a.error ? `error: ${a.error}` : a.facts.length ? a.facts.map((f) => `${f.label} ${f.value}`).join(', ') : a.note}`);
        return ok(lines.join('\n'));
      }),

      tool(
        'claude_accounts',
        "The owner's Claude subscriptions on this server. action list: which accounts exist and which one the agents use. There is no MAIN account: agents use the account in use, and if it fails or hits its limit they move to the next one by themselves (and the owner is told). action switch: make `account` (name, label, e-mail, or 'next' for the other one) the one agents use, from their next message on, for when a limit is reached. action add: send the owner a secure page to sign in with another Claude account. Switch only when the owner asks, or after telling them a limit is reached and they agree.",
        { action: z.enum(['list', 'switch', 'add']).default('list'), account: z.string().optional() },
        async ({ action, account }) => {
          try {
            if (action === 'add') {
              deps.sendAuthLink(deps.providers.claude.loginFlow());
              return ok('The sign-in page was sent to the owner. They sign in with the other Claude account and paste the code; they get a confirmation in chat.');
            }
            if (action === 'switch') {
              const a = await deps.manager.switchClaudeAccount(account ?? 'next');
              return ok(`Agents now run on ${a.label}${a.plan ? ` (${a.plan})` : ''} from their next message. Your current reply still finishes on the previous account.`);
            }
            const list = await deps.manager.claudeAccounts();
            return ok(list.map((a) => `${a.active ? '→' : ' '} ${a.label}${a.plan ? ` (${a.plan})` : ''}${a.active ? ' — in use' : ''}${a.health?.lastFail && !(a.health.lastOk && a.health.lastOk > a.health.lastFail) ? ` — failed ${a.health.lastFail}${a.health.resetHint ? `, resets ${a.health.resetHint}` : ''}` : ''}`).join('\n') || 'No Claude account saved.');
          } catch (err) {
            return fail(err instanceof Error ? err.message : String(err));
          }
        },
      ),

      tool('setup_connector', "Send the owner a connector's setup page (credentials or settings it needs).", { name: z.string() }, async ({ name }) => {
        const connector = deps.connectors.get(name);
        if (!connector) return fail(`No connector "${name}".`);
        if (!connector.setup) return fail(`${name} needs no setup.`);
        deps.sendAuthLink(await connector.setup());
        return ok(`The setup page for ${name} was sent to the owner. They get a confirmation in chat when done.`);
      }),

      tool(
        'request_credentials',
        'Ask the owner for credentials (API keys, passwords, tokens) through a secure one-time web page. NEVER ask for secrets in chat. The link is sent to the owner directly; the values are stored encrypted under `id` and you never see them.',
        {
          id: z.string().regex(SECRET_ID).describe('Where to store them, e.g. "github:token"'),
          title: z.string().describe('Page title, e.g. "GitHub token"'),
          description: z.string().optional().describe('What it is for and how to get it'),
          fields: z
            .array(
              z.object({
                name: z.string(),
                label: z.string(),
                type: z.enum(['text', 'password', 'email', 'number', 'url', 'tel', 'textarea']).default('text'),
                secret: z.boolean().optional(),
                optional: z.boolean().optional(),
                help: z.string().optional(),
              }),
            )
            .min(1),
          links: z.array(z.object({ label: z.string(), url: z.url() })).optional().describe('Helpful links, e.g. where to create the key'),
        },
        async ({ id, title, description, fields, links }) => {
          deps.sendAuthLink(formFlow(deps.secrets, { title, description, fields, links, secretId: id, label: title }));
          return ok(`A secure link for "${title}" was sent to the owner. They get a confirmation in chat when done; use list_credentials to check.`);
        },
      ),

      tool(
        'start_oauth',
        "Connect an account through the provider's own sign-in page (OAuth). If the owner has not set up an OAuth client for the provider yet, the same page asks for it first.",
        {
          provider: z.enum(Object.keys(PROVIDERS) as [string, ...string[]]),
          scopes: z.array(z.string()).min(1),
          id: z.string().regex(SECRET_ID).describe('Where to store the tokens, e.g. "google:gmail"'),
          description: z.string().optional(),
        },
        async ({ provider, scopes, id, description }) => {
          deps.sendAuthLink(oauthFlow(deps.secrets, { provider: PROVIDERS[provider]!, scopes, secretId: id, description }));
          return ok(`A sign-in link for ${PROVIDERS[provider]!.name} was sent to the owner. They get a confirmation in chat when done; use list_credentials to check.`);
        },
      ),

      tool('list_credentials', 'List stored credentials: ids, how they were collected and which fields they hold (never the values).', {}, async () => {
        const list = await deps.secrets.list();
        if (!list.length) return ok('No credentials stored.');
        return ok(list.map((s) => `- ${s.id} (${s.kind}${s.label ? `, ${s.label}` : ''}): ${s.fields.join(', ')} · updated ${s.updatedAt}`).join('\n'));
      }),

      tool('delete_credentials', 'Delete stored credentials. Asks the owner first.', { id: z.string() }, async ({ id }) => {
        if (!(await deps.secrets.has(id))) return fail(`No credentials "${id}".`);
        const approved = await deps.approve({ agent: 'sunny', tool: 'delete_credentials', summary: `Delete credentials "${id}"`, reason: 'cannot be undone' });
        if (!approved) return fail('The owner kept them.');
        await deps.secrets.delete(id);
        return ok(`Deleted "${id}".`);
      }),

      // ── Telegram ─────────────────────────────────────────────────────────────

      tool('telegram_status', "Sunny's Telegram bot and the agents' own bots: which run, and who started them.", {}, async () => {
        if (!deps.telegram) return fail('Telegram is not available in this daemon.');
        return ok(await deps.telegram.describe());
      }),

      tool(
        'setup_telegram',
        "Set up a Telegram bot: Sunny's own (no agent), or an agent's own bot so people talk to it directly. Without a token yet, the owner gets a secure page for the token from @BotFather; once it runs, they get the bot's link. Sunny sets the bot's name, description and picture from the agent. You never see the token.",
        { agent: z.string().optional().describe('Agent that gets its own bot; omit for Sunny’s bot') },
        async ({ agent }) => {
          if (!deps.telegram) return fail('Telegram is not available in this daemon.');
          try {
            return ok(await deps.telegram.setup(deps.conversationId, agent ?? 'sunny'));
          } catch (err) {
            return fail((err as Error).message);
          }
        },
      ),

      tool('remove_telegram_bot', "Stop an agent's own Telegram bot and forget its token. Asks the owner first.", { agent: z.string() }, async ({ agent }) => {
        if (!deps.telegram) return fail('Telegram is not available in this daemon.');
        const approved = await deps.approve({ agent: 'sunny', tool: 'remove_telegram_bot', summary: `Remove ${agent}'s Telegram bot`, reason: 'people will reach it through Sunny’s bot only' });
        if (!approved) return fail('The owner kept the bot.');
        return ok((await deps.telegram.removeBot(agent)) ? `Removed ${agent}'s bot.` : `${agent} had no bot.`);
      }),

      // ── People and access ────────────────────────────────────────────────────

      tool('list_users', 'People who can use Sunny: the owner (with their linked Telegram accounts) and guests with the agents they may use.', {}, async () => {
        const list = await users.list();
        return ok(
          list
            .map((u) => {
              const accounts = u.identities.map((i) => `${i.channel} ${i.label ?? i.externalId} (id ${i.externalId})`).join('; ') || 'no linked account yet';
              return `- ${u.name} [${u.id}, ${u.role}]: ${accounts}${u.role === 'member' ? ` · agents: ${u.agents.join(', ') || 'none'}` : ''}`;
            })
            .join('\n'),
        );
      }),

      tool(
        'add_user',
        'Add a guest (a friend) who may use some agents. Then grant_access to agents and invite_user to send them a link.',
        { id: z.string().regex(USER_ID).describe('Short id, e.g. "alice"'), name: z.string().min(1).max(60) },
        async ({ id, name }) => {
          try {
            await users.create(id, name);
          } catch (err) {
            return fail((err as Error).message);
          }
          return ok(`Added ${name} (${id}). They cannot use anything until you grant_access.`);
        },
      ),

      tool('remove_user', 'Remove a guest: their linked accounts and access go too. Asks the owner first.', { id: z.string() }, async ({ id }) => {
        if (id === OWNER_ID) return fail('The owner cannot be removed.');
        const user = await users.get(id);
        if (!user) return fail(`No user "${id}".`);
        const approved = await deps.approve({ agent: 'sunny', tool: 'remove_user', summary: `Remove ${user.name}`, reason: 'their accounts lose all access' });
        if (!approved) return fail('The owner kept them.');
        await users.remove(id);
        return ok(`Removed ${user.name}.`);
      }),

      tool(
        'grant_access',
        "Let a guest use an agent (on the agent's own bot, or through Sunny's bot). Asks the owner first. Guests never talk to Sunny, never answer approvals, and anything that changes things asks the owner.",
        { user: z.string(), agent: z.string() },
        async ({ user: id, agent }) => {
          const user = await users.get(id);
          if (!user) return fail(`No user "${id}".`);
          if (user.role === 'owner') return fail('The owner already has access to everything.');
          const a = registry.get(agent);
          if (!a) return fail(`No agent named "${agent}".`);
          const risky = privilegedReasons(a.def);
          const approved = await deps.approve({
            agent: 'sunny',
            tool: 'grant_access',
            summary: `Let ${user.name} use ${agent}`,
            reason: risky.length ? `${agent} has: ${risky.join('; ')}` : `${agent} is a restricted agent`,
          });
          if (!approved) return fail('The owner did not approve.');
          await users.grant(id, agent);
          const note = a.def.memory.session === 'shared' ? ` ${agent} keeps a shared history; ${user.name} gets a separate one.` : '';
          return ok(`${user.name} can now use ${agent}.${note} Use invite_user if they have no linked account yet.`);
        },
      ),

      tool('revoke_access', "Stop a guest from using an agent.", { user: z.string(), agent: z.string() }, async ({ user, agent }) =>
        ok((await users.revoke(user, agent)) ? `${user} can no longer use ${agent}.` : `${user} had no access to ${agent}.`),
      ),

      tool(
        'invite_user',
        "Create a one-time link that links a Telegram account to a user: a guest, or another of the owner's own accounts (user \"owner\"). The link goes to the owner to pass on; you never see it. With `agent`, it opens that agent's own bot.",
        { user: z.string(), agent: z.string().optional().describe("Agent whose bot the link opens; default Sunny's bot") },
        async ({ user, agent }) => {
          if (!deps.telegram) return fail('Telegram is not available in this daemon.');
          try {
            return ok(await deps.telegram.invite(deps.conversationId, user, agent ?? 'sunny'));
          } catch (err) {
            return fail((err as Error).message);
          }
        },
      ),
    ],
  });
}
