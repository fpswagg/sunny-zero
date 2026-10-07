import { existsSync, watch } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { config } from './config.ts';
import { log } from './log.ts';
import { AgentRegistry } from './agents/registry.ts';
import { AuthManager } from './auth/manager.ts';
import { ConnectorRegistry, type ConnectorRuntime } from './connectors/types.ts';
import { notionConnector } from './connectors/notion/index.ts';
import { xConnector } from './connectors/x/index.ts';
import { instagramConnector } from './connectors/instagram/index.ts';
import { tiktokConnector } from './connectors/tiktok/index.ts';
import { letterboxdConnector } from './connectors/letterboxd/index.ts';
import { telegramUserConnector } from './connectors/telegram-user/index.ts';
import { githubConnector } from './connectors/github/index.ts';
import { vercelConnector } from './connectors/vercel/index.ts';
import { gmailConnector } from './connectors/gmail/index.ts';
import { driveConnector } from './connectors/gdrive/index.ts';
import { youtubeConnector } from './connectors/youtube/index.ts';
import { dropboxConnector } from './connectors/dropbox/index.ts';
import { spotifyConnector } from './connectors/spotify/index.ts';
import { figmaConnector } from './connectors/figma/index.ts';
import { redditConnector } from './connectors/reddit/index.ts';
import { notionCalendarConnector } from './connectors/notion-calendar/index.ts';
import { vpsConnector } from './connectors/vps/index.ts';
import { notifyConnector } from './connectors/notify.ts';
import { Gateway } from './gateway/gateway.ts';
import { Runner } from './runtime/runner.ts';
import { SessionStore } from './runtime/sessions.ts';
import { RunLog } from './runtime/run-log.ts';
import { ConversationStore } from './gateway/conversations.ts';
import { connectDb, migrate } from './db/db.ts';
import { importLegacyFiles } from './db/import-files.ts';
import { SecretStore } from './secrets/store.ts';
import { createHttpServer } from './server/http.ts';
import { sunnyAgent } from './sunny/sunny.ts';
import { parseConversation, TelegramHub } from './telegram/hub.ts';
import { Scheduler } from './triggers/scheduler.ts';
import { EventBus } from './triggers/events.ts';
import { Maintenance } from './maintenance.ts';
import { PendingTasks } from './triggers/pending.ts';
import { UserStore } from './users/users.ts';
import { Inbox } from './media/inbox.ts';
import { ELEVENLABS_SECRET_ID } from './media/tts.ts';
import { ElevenLabsTranscriber, FallbackTranscriber, OpenAiTranscriber, WorkerTranscriber } from './media/transcribe.ts';
import { Providers } from './providers/providers.ts';
import { LlmProxy } from './providers/proxy.ts';
import { AgentManager } from './manage/manager.ts';
import { SettingsStore } from './manage/settings.ts';
import { registerManageCommands } from './manage/commands.ts';
import { Prefs } from './manage/prefs.ts';
import { AgentBackups } from './manage/backup.ts';
import { registerExtraCommands } from './manage/extras.ts';
import { UsageCard } from './manage/usage-card.ts';
import { registerMiniApp } from './miniapp/api.ts';
import { TtsService } from './media/tts.ts';
import { registerWebApps } from './webapp/routes.ts';
import { WebSessions } from './webapp/sessions.ts';

/** Token terminal and web clients use to connect to the daemon. Created on first start. */
export async function loadAdminToken(create: boolean): Promise<string> {
  const path = join(config.dataDir, 'admin.token');
  if (!existsSync(path)) {
    if (!create) throw new Error(`no ${path}; start the daemon first (sunny serve)`);
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(path, randomBytes(24).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
  }
  return (await readFile(path, 'utf8')).trim();
}

export async function startDaemon(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  const adminToken = await loadAdminToken(true);
  if (!config.SUNNY_DATABASE_URL) throw new Error('SUNNY_DATABASE_URL is not set (see .env.example)');
  const sql = connectDb(config.SUNNY_DATABASE_URL);
  const applied = await migrate(sql);
  if (applied) log.info({ applied }, 'database migrated');
  await importLegacyFiles(sql, config.dataDir);

  const registry = new AgentRegistry(config.agentsDir, join(config.dataDir, 'trash'));
  await registry.load();
  const sessions = new SessionStore(sql);
  const secrets = new SecretStore(sql, config.dataDir, config.SUNNY_MASTER_KEY);
  const runs = new RunLog(sql);
  const users = new UserStore(sql);
  const connectors = new ConnectorRegistry();
  // Agents on other model providers reach them through this local proxy, which holds the keys.
  const providers = new Providers(secrets);
  const loopback = ['0.0.0.0', '::', 'localhost'].includes(config.SUNNY_BIND) ? '127.0.0.1' : config.SUNNY_BIND;
  const proxy = new LlmProxy(providers, `http://${loopback.includes(':') ? `[${loopback}]` : loopback}:${config.SUNNY_PORT}/llm`);
  const settings = new SettingsStore(sql);
  const prefs = await Prefs.of(settings).load();
  const runner = new Runner(sessions, connectors, runs, { providers, proxy, defaultModel: config.SUNNY_AGENT_DEFAULT_MODEL }, settings);
  const sunny = sunnyAgent();
  const manager = new AgentManager({
    registry,
    providers,
    runs,
    sessions,
    settings,
    users,
    sunny,
    timezone: config.SUNNY_TIMEZONE,
    defaults: { sunny: config.SUNNY_MODEL, agents: config.SUNNY_AGENT_DEFAULT_MODEL },
    probe: (name, provider, model, effort) => runner.probe(name, provider, model, effort),
    upcoming: (agent) => scheduler?.upcoming(agent) ?? [],
    telegram: () => telegram,
  });
  await manager.init();
  // The Telegram app needs an HTTPS address Telegram can open.
  const appUrl = config.publicUrl.startsWith('https://') ? `${config.publicUrl}/app` : undefined;
  const auth = new AuthManager(config.publicUrl, config.SUNNY_AUTH_LINK_TTL_MIN * 60_000);
  const workerTranscriber = new WorkerTranscriber({
    model: config.SUNNY_WHISPER_MODEL,
    cacheDir: join(config.dataDir, 'models'),
    languages: config.SUNNY_WHISPER_LANGUAGES,
    maxSeconds: config.SUNNY_TRANSCRIBE_MAX_MIN * 60,
    idleMs: 10 * 60_000,
  });
  const transcriber = new FallbackTranscriber([
    new ElevenLabsTranscriber(async () => (await secrets.get(ELEVENLABS_SECRET_ID))?.apiKey, config.SUNNY_TRANSCRIBE_MAX_MIN * 60),
    new OpenAiTranscriber(async () => (await providers.credentials('openai'))?.apiKey, config.SUNNY_TRANSCRIBE_MAX_MIN * 60),
    workerTranscriber,
  ], () => ['Sunny', ...registry.list().map((a) => a.def.name.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' '))]);
  const inbox = new Inbox({ stagingDir: join(config.dataDir, 'staging'), keepDays: config.SUNNY_INBOX_DAYS, transcriber });
  // Voice replies and calls; agent web apps at /a/<agent>/.
  const tts = new TtsService({ secrets, providers });
  const webSessions = new WebSessions(sql);

  // Created after the gateway (they need it), used by Sunny's tools through the closure below.
  let telegram: TelegramHub | undefined;
  let scheduler: Scheduler | undefined;
  let events: EventBus | undefined;

  const gateway = new Gateway({
    registry,
    runner,
    sessions,
    auth,
    users,
    conversations: new ConversationStore(sql),
    sunny,
    approvalTimeoutMs: config.SUNNY_APPROVAL_TIMEOUT_MIN * 60_000,
    inbox,
    tts,
    settings,
    runs,
    timezone: config.SUNNY_TIMEZONE,
    pending: new PendingTasks(sql),
    sunnyDeps: (bound) => ({
      ...bound,
      registry,
      connectors,
      secrets,
      users,
      telegram,
      manager,
      providers,
      timezone: config.SUNNY_TIMEZONE,
      inboxDir: join(config.dataDir, 'sunny', 'inbox'),
      forgetSessions: (agent) => sessions.clearAgent(agent),
      recentRuns: (agent, limit) => runs.recent(agent, limit),
      recentEvents: (hours, source) => events?.recent(hours, source) ?? Promise.resolve([]),
      upcoming: (agent) => scheduler?.upcoming(agent) ?? [],
    }),
  });

  connectors.register(notifyConnector({ deliver: (agent, targets, text, silent) => gateway.notify(agent, targets, text, silent), sql }));
  connectors.register(vpsConnector({ sql, secrets }));
  connectors.register(notionConnector({ secrets }));
  connectors.register(xConnector({ secrets }));
  connectors.register(instagramConnector({ secrets }));
  connectors.register(tiktokConnector({ secrets }));
  connectors.register(letterboxdConnector({ secrets }));
  connectors.register(telegramUserConnector({ secrets }));
  connectors.register(githubConnector({ secrets }));
  connectors.register(vercelConnector({ secrets }));
  connectors.register(gmailConnector({ secrets }));
  connectors.register(driveConnector({ secrets }));
  connectors.register(youtubeConnector({ secrets }));
  connectors.register(dropboxConnector({ secrets }));
  connectors.register(spotifyConnector({ secrets }));
  connectors.register(figmaConnector({ secrets }));
  connectors.register(redditConnector({ secrets }));
  connectors.register(notionCalendarConnector({ secrets }));

  const agentAppUrl = (agent: string) => (config.publicUrl.startsWith('https://') ? `${config.publicUrl}/a/${agent}/` : undefined);
  telegram = new TelegramHub({ gateway, secrets, sql, users, registry, sunny, inviteTtlMs: config.SUNNY_AUTH_LINK_TTL_MIN * 60_000, inbox, appUrl, agentAppUrl, prefs });
  gateway.addCommand('apps', {
    usage: '',
    help: 'every app: the manager and each agent’s chat and voice app',
    run: async () => {
      const names = ['sunny', ...registry.list().filter((a) => a.def.enabled).map((a) => a.def.name)];
      const buttons: { label: string; webApp?: string; command?: string }[][] = [];
      if (appUrl) buttons.push([{ label: '⚙ Manager', webApp: appUrl }]);
      const row: { label: string; webApp: string }[] = names.flatMap((n) => {
        const url = agentAppUrl(n);
        return url ? [{ label: `📱 ${n}`, webApp: url }] : [];
      });
      for (let i = 0; i < row.length; i += 3) buttons.push(row.slice(i, i + 3));
      if (!buttons.length) return 'The apps need Sunny on https (SUNNY_PUBLIC_URL).';
      return { text: '📱 **Apps**: tap one to open it.', buttons };
    },
  });

  gateway.addCommand('app', {
    usage: '[agent]',
    help: "open an agent's app: chat and voice call, in Telegram or in a browser",
    run: async (conversationId, arg) => {
      const bot = parseConversation(conversationId)?.bot;
      const agent = arg.trim().toLowerCase() || (bot && bot !== 'sunny' ? bot : await gateway.currentAgent(conversationId));
      if (agent !== 'sunny' && !registry.get(agent)) return `No agent named "${agent}".`;
      const url = agentAppUrl(agent);
      if (!url) return 'The apps need Sunny on https (SUNNY_PUBLIC_URL).';
      const owner = await users.owner();
      const login = `${config.publicUrl}/a/${agent}/login/${webSessions.link(owner.id, agent)}`;
      return {
        text: `📱 **${agent}** app: chat and voice call, same conversation as here.\nThe browser link signs that browser in (valid 10 min, once). Then add it to your home screen.`,
        buttons: [[{ label: '📱 Open app', webApp: url }], [{ label: '🌐 Open in browser', url: login }]],
      };
    },
  });
  registerManageCommands({ gateway, manager, providers, appAvailable: !!appUrl });
  const backups = new AgentBackups({ agentsDir: config.agentsDir, dataDir: config.dataDir, settings, timezone: config.SUNNY_TIMEZONE });
  manager.attachBackups(backups);
  backups.start();
  registerExtraCommands({ gateway, settings, runs, backups, timezone: config.SUNNY_TIMEZONE, agents: () => manager.names() });
  const usageCard = new UsageCard({ host: telegram, manager, settings, gateway });
  usageCard.start();
  events = new EventBus(registry, sql, (agent, message, origin) => gateway.runTask(agent, message, origin));
  scheduler = new Scheduler(registry, (agent, prompt, origin) => gateway.runTask(agent, prompt, origin), config.SUNNY_TIMEZONE);

  const { app } = await createHttpServer({
    auth,
    gateway,
    adminToken,
    eventsSecret: config.SUNNY_EVENTS_SECRET,
    emitExternalEvent: (event) => events!.emit(event),
    routes: [
      (http) => proxy.register(http),
      (http) => registerMiniApp(http, { manager, providers, connectors, users, secrets, gateway, telegram: () => telegram, timezone: config.SUNNY_TIMEZONE, tts }),
      (http) =>
        registerWebApps(http, {
          gateway,
          registry,
          sunny,
          users,
          secrets,
          sql,
          runs,
          sessions: webSessions,
          tts,
          limits: { subscription: (force) => manager.subscriptionUsage(force), accounts: (force) => manager.providerAccounts(force) },
          transcribe: (file) => transcriber.transcribe(file),
          stagingDir: join(config.dataDir, 'staging'),
          publicUrl: config.publicUrl,
        }),
    ],
  });
  await app.listen({ port: config.SUNNY_PORT, host: config.SUNNY_BIND });
  log.info({ listen: `${config.SUNNY_BIND}:${config.SUNNY_PORT}`, publicUrl: config.publicUrl, timezone: config.SUNNY_TIMEZONE }, 'sunny is up');
  await telegram.start();
  scheduler.sync();
  gateway.startPendingResume();

  const runtime: ConnectorRuntime = {
    emit: (event) => events!.emit(event),
    notifyOwner: (text) => void gateway.notify('sunny', [], text, false),
  };
  runner.notifyOwner = (text) => void gateway.notify('sunny', [], text, false).catch((err) => log.warn({ err }, 'could not tell the owner about the Claude account switch'));
  for (const connector of connectors.list()) {
    await connector.start?.(runtime).catch((err) => log.error({ err, connector: connector.name }, 'connector did not start'));
  }

  // Agents edited by hand (agent.json, prompt.md, icon.svg) are picked up without a restart.
  let reload: NodeJS.Timeout | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  let stopping = false;
  const startWatch = () => {
    try {
      watcher = watch(config.agentsDir, { recursive: true }, (_event, file) => {
        if (!file || !/(^|\/)(agent\.json|prompt\.md|icon\.svg)$/.test(file)) return;
        clearTimeout(reload);
        reload = setTimeout(() => registry.load().catch((err) => log.error({ err }, 'agent reload failed')), 300);
      });
      // Removing a folder under agents/ (a skin, a workspace) makes the recursive watcher emit an
      // error; unhandled, that would take the whole daemon down. Log it and start watching again.
      watcher.on('error', (err) => {
        log.warn({ err }, 'agents watcher error, restarting it');
        watcher?.close();
        if (!stopping) setTimeout(startWatch, 1000);
      });
    } catch (err) {
      log.warn({ err }, 'agents watcher could not start');
    }
  };
  startWatch();

  // Files sent in chat are kept SUNNY_INBOX_DAYS days.
  const prune = () =>
    inbox
      .prune([join(config.dataDir, 'sunny'), ...registry.list().map((a) => a.dir)])
      .then((removed) => removed && log.info({ removed }, 'inbox: old days removed'))
      .catch((err) => log.warn({ err }, 'inbox: prune failed'));
  void prune();
  void webSessions.prune().catch(() => {});
  const pruneTimer = setInterval(prune, 6 * 3_600_000);

  const maintenance = new Maintenance({ sql, timezone: config.SUNNY_TIMEZONE, busy: () => gateway.isBusy(), restart: () => void shutdown('maintenance') });
  maintenance.start();

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    clearInterval(pruneTimer);
    stopping = true;
    watcher?.close();
    auth.close();
    proxy.close();
    scheduler.stop();
    gateway.stopPendingResume();
    await gateway.noteRestart().catch(() => {});
    maintenance.stop();
    usageCard.stop();
    backups.stop();
    workerTranscriber.stop();
    for (const connector of connectors.list()) await connector.stop?.().catch(() => {});
    await telegram.stop();
    await app.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
