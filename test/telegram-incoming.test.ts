import { describe, expect, it } from 'vitest';
import type { Message } from 'grammy/types';
import { describeMessage } from '../src/telegram/incoming.ts';

const msg = (extra: object): Message => ({ message_id: 7, date: 0, chat: { id: 1, type: 'private', first_name: 'O' }, from: { id: 1, is_bot: false, first_name: 'O' }, ...extra }) as Message;

describe('describeMessage', () => {
  it('keeps plain text as it is', () => {
    expect(describeMessage(msg({ text: 'hello' }))).toEqual({ text: 'hello', media: [] });
  });

  it('takes the largest photo with its caption', () => {
    const d = describeMessage(msg({ caption: 'what is this?', photo: [{ file_id: 'small', width: 90 }, { file_id: 'big', width: 1280, file_size: 1000 }] }));
    expect(d.text).toBe('what is this?');
    expect(d.media).toEqual([{ kind: 'photo', fileId: 'big', name: 'photo-7.jpg', mime: 'image/jpeg', size: 1000, note: undefined }]);
  });

  it('names voice messages, documents, audio, video and video messages', () => {
    expect(describeMessage(msg({ voice: { file_id: 'v', duration: 3, mime_type: 'audio/ogg' } })).media[0]).toMatchObject({ kind: 'voice', name: 'voice-7.ogg' });
    expect(describeMessage(msg({ document: { file_id: 'd', file_name: 'report.pdf', mime_type: 'application/pdf' } })).media[0]).toMatchObject({ kind: 'document', name: 'report.pdf', mime: 'application/pdf' });
    expect(describeMessage(msg({ audio: { file_id: 'a', duration: 9, performer: 'Artist', title: 'Song' } })).media[0]).toMatchObject({ kind: 'audio', name: 'Artist – Song.mp3', note: '"Artist – Song"' });
    expect(describeMessage(msg({ video: { file_id: 'vi', duration: 9 } })).media[0]).toMatchObject({ kind: 'video', name: 'video-7.mp4' });
    expect(describeMessage(msg({ video_note: { file_id: 'n', duration: 9, length: 240 } })).media[0]).toMatchObject({ kind: 'video_note' });
  });

  it('treats a GIF as an animation, not also as a document', () => {
    const d = describeMessage(msg({ animation: { file_id: 'g', file_name: 'fun.mp4' }, document: { file_id: 'g', file_name: 'fun.mp4' } }));
    expect(d.media).toHaveLength(1);
    expect(d.media[0]).toMatchObject({ kind: 'animation', name: 'fun.mp4' });
  });

  it('uses the still thumbnail of animated stickers', () => {
    const still = describeMessage(msg({ sticker: { file_id: 's', is_animated: false, is_video: false, emoji: '😂', set_name: 'Fun' } }));
    expect(still.media[0]).toMatchObject({ kind: 'sticker', fileId: 's', note: '😂 from the set "Fun"' });
    const animated = describeMessage(msg({ sticker: { file_id: 's', is_animated: true, is_video: false, emoji: '🔥', thumbnail: { file_id: 'thumb' } } }));
    expect(animated.media[0]).toMatchObject({ fileId: 'thumb' });
    const bare = describeMessage(msg({ sticker: { file_id: 's', is_animated: true, is_video: false, emoji: '🔥' } }));
    expect(bare).toEqual({ text: '🏷 Sticker 🔥', media: [] });
  });

  it('spells out places, contacts, polls, checklists and dice', () => {
    expect(describeMessage(msg({ location: { latitude: 4.05, longitude: 9.7 } })).text).toBe('📍 Location: 4.050000, 9.700000 (https://maps.google.com/?q=4.05,9.7)');
    expect(describeMessage(msg({ venue: { title: 'Café', address: '1 Rue X', location: { latitude: 1, longitude: 2 } }, location: { latitude: 1, longitude: 2 } })).text).toMatch(/^📍 Place: Café, 1 Rue X at 1\.000000/);
    expect(describeMessage(msg({ contact: { first_name: 'Ana', last_name: 'B', phone_number: '+237600' } })).text).toBe('👤 Contact: Ana B, +237600');
    expect(describeMessage(msg({ poll: { question: 'Lunch?', options: [{ text: 'Yes', voter_count: 0 }, { text: 'No', voter_count: 0 }], total_voter_count: 0, type: 'regular', allows_multiple_answers: false } })).text).toBe('📊 Poll: "Lunch?"\n1. Yes\n2. No');
    expect(describeMessage(msg({ checklist: { title: 'Trip', tasks: [{ id: 1, text: 'Pack', completion_date: 5 }, { id: 2, text: 'Go' }] } })).text).toBe('☑ Checklist: "Trip"\n- [x] Pack\n- [ ] Go');
    expect(describeMessage(msg({ dice: { emoji: '🎲', value: 4 } })).text).toBe('🎲 They rolled 4.');
  });

  it('says where a forward comes from and what a reply answers', () => {
    const fwd = describeMessage(msg({ text: 'look', forward_origin: { type: 'channel', date: 0, chat: { id: 5, type: 'channel', title: 'News' }, message_id: 1 } }));
    expect(fwd.text).toBe('↪ Forwarded from the channel News, sent 1970-01-01 00:00 UTC:\nlook');
    const reply = describeMessage(msg({ text: 'yes that', reply_to_message: { message_id: 3, date: 0, chat: { id: 1, type: 'private' }, from: { id: 9, is_bot: true, first_name: 'Sunny' }, text: 'Shall I restart it?' } }));
    expect(reply.text).toBe('↩ Replying to your message: "Shall I restart it?"\nyes that');
    const quoted = describeMessage(msg({ text: 'this part', quote: { text: 'restart', position: 9 }, reply_to_message: { message_id: 3, date: 0, chat: { id: 1, type: 'private' }, from: { id: 1, is_bot: false, first_name: 'O' }, photo: [{ file_id: 'p' }], caption: 'long caption' } }));
    expect(quoted.text).toBe('↩ Replying to their earlier message (a photo): "restart"\nthis part');
  });

  it('flags messages an agent cannot use', () => {
    expect(describeMessage(msg({ game: { title: 'x' } }))).toEqual({ text: '', media: [], unsupported: 'a game' });
  });
});
