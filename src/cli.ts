#!/usr/bin/env node
import { parseArgs, styleText } from 'node:util';
import { createInterface, type Interface } from 'node:readline/promises';
import { config } from './config.ts';
import { loadAdminToken } from './daemon.ts';
import { SocketClient } from './client/socket-client.ts';
import type { Outbound } from './gateway/types.ts';

const USAGE = `Usage:
  sunny serve                       start the daemon (web server + agents)
  sunny chat [-a agent] [-c name]   chat in the terminal (conversation "name", default "default")
  sunny ask [-a agent] <message>    send one message, print the reply, exit
  sunny setup telegram [agent]      connect Sunny's Telegram bot, or an agent's own (token typed hidden)
  sunny token                       print the client token (for the web UI)`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: 'string', short: 'a' },
    conversation: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command = 'chat', ...rest] = positionals;
const daemonUrl = process.env.SUNNY_URL ?? `ws://127.0.0.1:${config.SUNNY_PORT}/ws`;

const dim = (s: string) => styleText('dim', s);
/** Bold and inline code for command output; streamed replies stay as written. */
const md = (s: string) => s.replace(/\*\*(.+?)\*\*/g, (_, t: string) => styleText('bold', t)).replace(/`([^`]+)`/g, (_, t: string) => styleText('cyan', t));

/** Prints streamed events, keeping track of whether the cursor is mid-line. */
class Printer {
  private midLine = false;
  private streamedAgent: string | undefined;

  private line(text: string): void {
    if (this.midLine) process.stdout.write('\n');
    this.midLine = false;
    console.log(text);
  }

  event(e: Outbound): void {
    switch (e.type) {
      case 'text':
        if (this.streamedAgent !== e.agent) {
          this.line(styleText(['bold', 'yellow'], `${e.agent}:`));
          this.streamedAgent = e.agent;
        }
        process.stdout.write(e.text);
        this.midLine = !e.text.endsWith('\n');
        break;
      case 'tool':
        this.streamedAgent = undefined;
        this.line(dim(`  ⚙ ${e.agent} · ${e.summary}`));
        break;
      case 'status':
        this.line(dim(`  ℹ ${e.agent ? `${e.agent} · ` : ''}${e.text}`));
        break;
      case 'reply':
        // Already streamed; print it only when nothing was (e.g. an error before any text).
        if (this.streamedAgent !== e.agent) this.line(`${styleText(['bold', 'yellow'], `${e.agent}:`)}\n${e.text}`);
        this.streamedAgent = undefined;
        this.line(dim(`  ${(e.durationMs / 1000).toFixed(1)}s${e.costUsd ? ` · ~$${e.costUsd.toFixed(4)} equiv.` : ''}${e.isError ? ' · error' : ''}`));
        break;
      case 'approval':
        this.line(styleText(['bold', 'magenta'], `⚠ ${e.agent} wants to: ${e.summary}`) + dim(` (${e.reason})`));
        break;
      case 'approval_closed':
        this.line(dim(`  ${e.allowed ? '✓ approved' : '✕ denied'}${e.by === 'user' ? '' : ` (${e.by})`}`));
        break;
      case 'auth_link':
        this.line(styleText('cyan', `🔑 ${e.title}: open ${e.url}`) + dim(` (expires ${new Date(e.expiresAt).toLocaleTimeString()})`));
        break;
      case 'notice':
        this.line(md(e.text));
        // Buttons become the commands they run (links and app pages are Telegram's).
        for (const b of (e.buttons ?? []).flat()) {
          if (b.command) this.line(dim(`  › ${b.command}`) + dim(`  ${b.label}`));
          else if (b.url) this.line(dim(`  › ${b.url}  ${b.label}`));
        }
        break;
      case 'notify':
        this.line(styleText(['bold', 'yellow'], `🔔 ${e.agent}: `) + md(e.text));
        break;
      case 'file':
        this.line(styleText(['bold', 'yellow'], `📎 ${e.agent} sent ${e.name}: `) + e.path + (e.caption ? `\n${md(e.caption)}` : ''));
        break;
      case 'error':
        this.line(styleText('red', `✕ ${e.text}`));
        break;
    }
  }
}

async function connect(onEvent: (e: Outbound) => void): Promise<SocketClient> {
  const token = await loadAdminToken(false);
  const client = new SocketClient({
    url: daemonUrl,
    token,
    channel: 'cli',
    conversation: values.conversation ?? 'default',
    onEvent,
    onClose: (reason) => {
      console.error(styleText('red', `\nDisconnected: ${reason}`));
      process.exit(1);
    },
  });
  try {
    await client.connect();
  } catch (err) {
    const msg = (err as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? `the daemon is not running at ${daemonUrl} (start it with: sunny serve)` : (err as Error).message;
    console.error(styleText('red', `Cannot connect: ${msg}`));
    process.exit(1);
  }
  return client;
}

async function askApproval(rl: Interface, client: SocketClient, e: Extract<Outbound, { type: 'approval' }>): Promise<void> {
  const answer = await rl.question(styleText('magenta', '  Allow? [y/N] '));
  client.approve(e.id, /^y(es)?$/i.test(answer.trim()));
}

async function chat(): Promise<void> {
  const printer = new Printer();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Hold input typed (or piped) before the connection is ready.
  rl.pause();
  let busy = false;
  const approvals: Extract<Outbound, { type: 'approval' }>[] = [];
  let answering = false;

  const prompt = () => {
    if (!busy && !answering) rl.setPrompt(styleText('green', 'you › ')), rl.prompt();
  };
  const drainApprovals = async () => {
    if (answering) return;
    answering = true;
    while (approvals.length) await askApproval(rl, client, approvals.shift()!);
    answering = false;
    prompt();
  };

  const client = await connect((e) => {
    printer.event(e);
    if (e.type === 'approval') {
      approvals.push(e);
      void drainApprovals();
    } else if (e.type === 'reply' || e.type === 'error') {
      busy = false;
      prompt();
    } else if (e.type === 'notice') {
      prompt();
    }
  });

  console.log(dim(`Connected to Sunny (${client.conversationId}). Talking to ${client.agent}. /help for commands, Ctrl+D to quit.`));
  if (values.agent) client.say(`/use ${values.agent}`);
  else prompt();

  rl.on('line', (line) => {
    if (answering) return;
    const text = line.trim();
    if (!text) return prompt();
    busy = !text.startsWith('/');
    client.say(text);
  });
  rl.on('close', () => {
    client.close();
    process.exit(0);
  });
  rl.resume();
}

async function ask(): Promise<void> {
  const message = rest.join(' ').trim();
  if (!message) {
    console.error(USAGE);
    process.exit(2);
  }
  const printer = new Printer();
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const target = values.agent ?? 'sunny';
  const client = await connect((e) => {
    printer.event(e);
    if (e.type === 'approval') {
      if (rl) void askApproval(rl, client, e);
      else client.approve(e.id, false);
    }
    if ((e.type === 'reply' && e.agent === target) || e.type === 'error') {
      rl?.close();
      client.close();
      process.exit(e.type === 'error' || (e.type === 'reply' && e.isError) ? 1 : 0);
    }
  });
  client.say(`@${target} ${message}`);
}

/** Reads a line without echoing it (or from a pipe: `echo $TOKEN | sunny setup telegram`). */
async function readHidden(prompt: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    let input = '';
    for await (const chunk of stdin) input += chunk;
    return input.split('\n')[0]!.trim();
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write('\n');
          return resolve(value.trim());
        }
        if (ch === '\u0003') {
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function setup(): Promise<void> {
  if (rest[0] !== 'telegram') {
    console.error(USAGE);
    process.exit(2);
  }
  const printer = new Printer();
  let client: SocketClient | undefined;
  client = await connect((e) => {
    printer.event(e);
    if (e.type === 'notice' || e.type === 'error') {
      client?.close();
      process.exit(e.type === 'error' ? 1 : 0);
    }
  });
  console.log(dim(`Create a bot with @BotFather in Telegram (/newbot)${rest[1] ? ` for ${rest[1]}` : ''} and paste the token it gives you.`));
  const token = await readHidden('Bot token: ');
  if (!token) process.exit(1);
  console.log(dim('Checking the token with Telegram…'));
  client.setupTelegram(token, rest[1]);
}

async function main(): Promise<void> {
  if (values.help) return console.log(USAGE);
  switch (command) {
    case 'serve': {
      const { startDaemon } = await import('./daemon.ts');
      return startDaemon();
    }
    case 'chat':
      return chat();
    case 'ask':
      return ask();
    case 'setup':
      return setup();
    case 'token':
      return console.log(await loadAdminToken(false));
    default:
      console.error(USAGE);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
