import pino from 'pino';
import { config } from './config.ts';

export const log = pino({
  level: config.LOG_LEVEL,
  transport: process.stdout.isTTY ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } : undefined,
});
