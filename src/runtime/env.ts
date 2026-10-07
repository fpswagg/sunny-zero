import { config } from '../config.ts';

/** Set by a running Claude Code session for its children; inheriting them confuses the agents' CLI. */
const PARENT_SESSION_VARS = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'AI_AGENT',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
]);

/** The daemon's own secrets (bot tokens, keys) never reach an agent that can run shell commands. */
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY/i;

/**
 * Environment for the Claude Code subprocess. Variables a parent Claude Code session sets are
 * removed (the daemon may be started from one), and so are secret-looking variables. ANTHROPIC_API_KEY
 * is kept only when SUNNY_USE_API_KEY is on, so runs bill the logged-in subscription by default.
 */
export function agentEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (PARENT_SESSION_VARS.has(key)) continue;
    if (key.startsWith('SUNNY_')) continue;
    if (key === 'ANTHROPIC_API_KEY') {
      if (config.SUNNY_USE_API_KEY) env[key] = value;
      continue;
    }
    // Claude Code's own long-lived subscription token (`claude setup-token`) is how headless runs log in.
    if (SECRET_NAME.test(key) && key !== 'CLAUDE_CODE_OAUTH_TOKEN') continue;
    env[key] = value;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'sunny/0.1';
  return env;
}
