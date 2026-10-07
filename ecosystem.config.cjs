// PM2 process file. Usage: `pnpm pm2:start` (start or reload, then save the list for reboots).
module.exports = {
  apps: [
    {
      name: 'sunny',
      cwd: __dirname,
      // No build step: tsx runs the TypeScript sources. .env is loaded by src/config.ts.
      script: 'src/cli.ts',
      args: 'serve',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      exec_mode: 'fork',
      instances: 1, // one daemon: Telegram allows a single getUpdates consumer per bot
      autorestart: true,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: '2G',
      // Graceful shutdown: stop Telegram polling, close the HTTP server and the database.
      kill_timeout: 15000,
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      merge_logs: true,
      time: false,
      env: { NODE_ENV: 'production' },
    },
  ],
};
