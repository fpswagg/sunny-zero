import { stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { FileKind } from '../gateway/types.ts';
import { unsendable } from './policy.ts';

/** Telegram's upload limit for bots. */
export const UPLOAD_LIMIT = 50 * 1024 * 1024;
/** Photos above this go as documents (Telegram's photo limit). */
const PHOTO_LIMIT = 10 * 1024 * 1024;

const BY_EXT: Record<string, FileKind> = {
  '.jpg': 'photo',
  '.jpeg': 'photo',
  '.png': 'photo',
  '.webp': 'photo',
  '.gif': 'animation',
  '.mp4': 'video',
  '.mov': 'video',
  '.webm': 'video',
  '.mp3': 'audio',
  '.m4a': 'audio',
  '.wav': 'audio',
  '.flac': 'audio',
  '.ogg': 'audio',
  '.oga': 'audio',
  '.opus': 'audio',
};

/** How a file is best shown: a photo, a video, a voice message (only when asked), or a plain document. */
export function fileKind(path: string, size: number, wanted?: FileKind): FileKind {
  const guess = BY_EXT[extname(path).toLowerCase()] ?? 'document';
  if (wanted === 'document') return 'document';
  if (wanted === 'voice') return guess === 'audio' ? 'voice' : guess;
  const kind = wanted && wanted === guess ? wanted : guess;
  return kind === 'photo' && size > PHOTO_LIMIT ? 'document' : kind;
}

export interface ChatToolsContext {
  cwd: string;
  /** Folders the agent can change, and folders it can only read. */
  roots: string[];
  readRoots: string[];
  dataDir: string;
  send(file: { path: string; name: string; kind: FileKind; caption?: string }): void;
  /** Records text in the agent's voice and sends it as a voice message (when voice replies are possible). */
  speak?(text: string, only?: boolean): Promise<void>;
}

/** Tools every agent has for the chat it is answering (or, in background runs, its notification targets). */
export function chatServer(ctx: ChatToolsContext): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'chat',
    version: '0.1.0',
    alwaysLoad: true,
    tools: [
      ...(ctx.speak ? [voiceTool(ctx.speak)] : []),
      tool(
        'send_file',
        'Send the user a file from your folders: a photo, chart, document, recording, export... It appears in their chat (a photo shows as a photo, an .ogg can go as a voice message). Write the file first (e.g. in your workspace), then send it. Files the user sent you are in your inbox/ folder.',
        {
          path: z.string().min(1).describe('Absolute path, or relative to your working directory'),
          caption: z.string().max(1000).optional().describe('Short text shown with the file (Markdown)'),
          as: z.enum(['photo', 'video', 'animation', 'audio', 'voice', 'document']).optional().describe('How to show it; guessed from the extension when omitted'),
        },
        async ({ path, caption, as }) => {
          const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
          const full = resolve(ctx.cwd, path);
          const refused = unsendable(full, ctx.roots, ctx.readRoots, ctx.dataDir);
          if (refused) return fail(`Not sent: ${refused}.`);
          const info = await stat(full).catch(() => undefined);
          if (!info?.isFile()) return fail(`Not sent: ${full} is not a file.`);
          if (!info.size) return fail('Not sent: the file is empty.');
          if (info.size > UPLOAD_LIMIT) return fail(`Not sent: ${Math.round(info.size / 1024 / 1024)} MB is over the 50 MB limit. Compress or split it.`);
          const kind = fileKind(full, info.size, as);
          ctx.send({ path: full, name: basename(full), kind, caption });
          return { content: [{ type: 'text' as const, text: `Sent ${basename(full)} as ${kind === 'document' ? 'a file' : `a ${kind}`}.` }] };
        },
      ),
    ],
  });
}

/** Voice notes the agent chooses to send, in its own voice. */
function voiceTool(speak: (text: string, only?: boolean) => Promise<void>) {
  return tool(
    'send_voice',
    [
      'Send the user a voice message in your own voice. You decide when: a good fit when they spoke to you (a voice message or call), when they ask for audio, or when something is easier to hear than read (a walkthrough, a story, a long explanation, a briefing).',
      'The voice note can carry fuller, more precise content than your text: explain in detail there, and keep the text reply as a short summary of it.',
      'If the user asked to be answered by voice only, set only=true and write nothing else. Write for the ear: natural spoken sentences, no Markdown, lists, tables, code, URLs or emoji; spell out numbers and abbreviations as you would say them. Use the language of the conversation. One voice note per answer is usually enough.',
    ].join(' '),
    {
      text: z.string().min(1).max(4000).describe('What to say, written to be spoken'),
      only: z
        .boolean()
        .optional()
        .describe('true when the user asked for a voice reply only (no text): the voice note is the whole answer, and any text you write after it is not delivered until the user writes again'),
    },
    async ({ text, only }) => {
      try {
        await speak(text, only);
        return {
          content: [
            {
              type: 'text' as const,
              text: only ? 'Voice message sent. Voice-only reply: stop here, the user gets no text from you this turn.' : 'Voice message sent.',
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Could not record the voice message: ${(err as Error).message}. Answer in text.` }], isError: true };
      }
    },
  );
}
