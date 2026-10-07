import type { Message } from 'grammy/types';
import type { MediaKind } from '../media/inbox.ts';

/** A file in a Telegram message, still on Telegram's servers. */
export interface MediaRef {
  kind: MediaKind;
  fileId: string;
  name: string;
  mime?: string;
  size?: number;
  note?: string;
}

export interface Described {
  /** What the agent reads: the text or caption, with forwards, replies, places, contacts and polls spelled out. */
  text: string;
  media: MediaRef[];
  /** Set when the message has nothing an agent can use (a game, a payment...): what it was. */
  unsupported?: string;
}

/** Bots can download files up to this size (Bot API getFile). */
export const DOWNLOAD_LIMIT = 20 * 1024 * 1024;

const EXCERPT = 600;
const excerpt = (s: string) => (s.length > EXCERPT ? s.slice(0, EXCERPT) + '…' : s);
const fullName = (u: { first_name: string; last_name?: string; username?: string }) =>
  `${[u.first_name, u.last_name].filter(Boolean).join(' ')}${u.username ? ` (@${u.username})` : ''}`;
const chatName = (c: { title?: string; username?: string; first_name?: string }) => c.title ?? (c.username ? `@${c.username}` : c.first_name ?? 'a chat');
const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

type Origin = NonNullable<Message['forward_origin']>;

function origin(o: Origin): string {
  switch (o.type) {
    case 'user':
      return fullName(o.sender_user);
    case 'hidden_user':
      return o.sender_user_name;
    case 'chat':
      return `${chatName(o.sender_chat)}${o.author_signature ? ` (${o.author_signature})` : ''}`;
    case 'channel':
      return `the channel ${chatName(o.chat)}${o.author_signature ? ` (${o.author_signature})` : ''}`;
  }
}

/** Fields shared by messages, replied-to messages and external replies. */
type Content = Pick<
  Message,
  'photo' | 'document' | 'animation' | 'audio' | 'voice' | 'video' | 'video_note' | 'sticker' | 'location' | 'venue' | 'contact' | 'poll' | 'dice' | 'story' | 'game' | 'invoice' | 'paid_media' | 'giveaway' | 'checklist' | 'live_photo'
>;

/** A short label for what a message holds, for replies to it. */
function kindOf(m: Content): string | undefined {
  if (m.photo || m.live_photo) return 'a photo';
  if (m.animation) return 'a GIF';
  if (m.video) return 'a video';
  if (m.video_note) return 'a video message';
  if (m.voice) return 'a voice message';
  if (m.audio) return `audio${m.audio.title ? ` "${m.audio.title}"` : ''}`;
  if (m.sticker) return `a sticker ${m.sticker.emoji ?? ''}`.trim();
  if (m.document) return `the file "${m.document.file_name ?? 'file'}"`;
  if (m.venue) return `the place ${m.venue.title}`;
  if (m.location) return 'a location';
  if (m.contact) return `the contact ${m.contact.first_name}`;
  if (m.poll) return `the poll "${m.poll.question}"`;
  if (m.checklist) return `the checklist "${m.checklist.title}"`;
  if (m.dice) return `a ${m.dice.emoji}`;
  if (m.story) return 'a story';
  return undefined;
}

const maps = (lat: number, lon: number) => `${lat.toFixed(6)}, ${lon.toFixed(6)} (https://maps.google.com/?q=${lat},${lon})`;

/** Turns a Telegram message into text an agent reads and the files it should get. */
export function describeMessage(m: Message): Described {
  const lines: string[] = [];
  const media: MediaRef[] = [];
  const id = m.message_id;

  if (m.forward_origin) lines.push(`↪ Forwarded from ${origin(m.forward_origin)}, sent ${day(m.forward_origin.date)}:`);

  const reply = m.reply_to_message;
  if (reply && !reply.forum_topic_created) {
    const whose = reply.from?.is_bot ? 'your message' : 'their earlier message';
    const said = m.quote?.text ?? reply.text ?? reply.caption;
    const what = kindOf(reply);
    lines.push(`↩ Replying to ${whose}${what ? ` (${what})` : ''}${said ? `: "${excerpt(said)}"` : ''}`);
  } else if (m.external_reply) {
    const what = kindOf(m.external_reply);
    const said = m.quote?.text;
    lines.push(`↩ Replying to a message from ${origin(m.external_reply.origin)}${what ? ` (${what})` : ''}${said ? `: "${excerpt(said)}"` : ''}`);
  }

  const body = m.text ?? m.caption;
  if (body) lines.push(body);

  // Files. An animation also carries a `document`; a live photo is shown as its still.
  const photo = m.photo ?? m.live_photo?.photo;
  if (photo?.length) {
    const best = photo.at(-1)!;
    media.push({ kind: 'photo', fileId: best.file_id, name: `photo-${id}.jpg`, mime: 'image/jpeg', size: best.file_size, note: m.live_photo ? '(live photo, still frame)' : undefined });
  }
  if (m.animation) {
    media.push({ kind: 'animation', fileId: m.animation.file_id, name: m.animation.file_name ?? `gif-${id}.mp4`, mime: m.animation.mime_type, size: m.animation.file_size });
  } else if (m.document) {
    media.push({ kind: 'document', fileId: m.document.file_id, name: m.document.file_name ?? `file-${id}`, mime: m.document.mime_type, size: m.document.file_size });
  }
  if (m.voice) media.push({ kind: 'voice', fileId: m.voice.file_id, name: `voice-${id}.ogg`, mime: m.voice.mime_type ?? 'audio/ogg', size: m.voice.file_size });
  if (m.audio) {
    const title = [m.audio.performer, m.audio.title].filter(Boolean).join(' – ');
    media.push({ kind: 'audio', fileId: m.audio.file_id, name: m.audio.file_name ?? `${title || `audio-${id}`}.mp3`, mime: m.audio.mime_type, size: m.audio.file_size, note: title ? `"${title}"` : undefined });
  }
  if (m.video) media.push({ kind: 'video', fileId: m.video.file_id, name: m.video.file_name ?? `video-${id}.mp4`, mime: m.video.mime_type, size: m.video.file_size });
  if (m.video_note) media.push({ kind: 'video_note', fileId: m.video_note.file_id, name: `video-message-${id}.mp4`, mime: 'video/mp4', size: m.video_note.file_size });
  if (m.sticker) {
    const s = m.sticker;
    const note = `${s.emoji ?? ''}${s.set_name ? ` from the set "${s.set_name}"` : ''}`.trim();
    // Animated stickers are Lottie or WebM; their still thumbnail is what the model can see.
    const still = s.is_animated || s.is_video ? s.thumbnail : s;
    if (still) media.push({ kind: 'sticker', fileId: still.file_id, name: `sticker-${id}.${s.is_animated || s.is_video ? 'jpg' : 'webp'}`, mime: 'image/webp', size: still.file_size, note: note || undefined });
    else lines.push(`🏷 Sticker ${note}`.trim());
  }

  // Things that are text already.
  if (m.venue) {
    lines.push(`📍 Place: ${m.venue.title}, ${m.venue.address} at ${maps(m.venue.location.latitude, m.venue.location.longitude)}`);
  } else if (m.location) {
    const l = m.location;
    const extra = [l.live_period ? 'live location, this is where they were when sharing' : '', l.horizontal_accuracy ? `±${Math.round(l.horizontal_accuracy)} m` : ''].filter(Boolean).join(', ');
    lines.push(`📍 Location: ${maps(l.latitude, l.longitude)}${extra ? ` (${extra})` : ''}`);
  }
  if (m.contact) {
    const c = m.contact;
    lines.push(`👤 Contact: ${[c.first_name, c.last_name].filter(Boolean).join(' ')}, ${c.phone_number}${c.user_id ? ` (Telegram user ${c.user_id})` : ''}`);
  }
  if (m.poll) {
    const p = m.poll;
    const options = p.options.map((o, i) => `${i + 1}. ${o.text}${p.total_voter_count ? ` (${o.voter_count})` : ''}`).join('\n');
    lines.push(`📊 ${p.type === 'quiz' ? 'Quiz' : 'Poll'}: "${p.question}"${p.allows_multiple_answers ? ' (several answers allowed)' : ''}\n${options}`);
  }
  if (m.checklist) {
    const c = m.checklist;
    lines.push(`☑ Checklist: "${c.title}"\n${c.tasks.map((t) => `- [${t.completion_date ? 'x' : ' '}] ${t.text}`).join('\n')}`);
  }
  if (m.dice) lines.push(`${m.dice.emoji} They rolled ${m.dice.value}.`);
  if (m.story) lines.push(`📖 A story from ${chatName(m.story.chat)} (stories can't be opened by bots).`);

  const text = lines.join('\n');
  if (!text && !media.length) {
    const what = m.game ? 'a game' : m.invoice ? 'an invoice' : m.paid_media ? 'paid media' : m.giveaway ? 'a giveaway' : 'this kind of message';
    return { text: '', media: [], unsupported: what };
  }
  return { text, media };
}
