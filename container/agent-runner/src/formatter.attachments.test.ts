import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getPendingMessages } from './db/messages-in.js';
import { extractPromptAttachments, formatMessages } from './formatter.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

function insertChat(id: string, content: object): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, content)
       VALUES (?, 'chat', ?, 'pending', ?)`,
    )
    .run(id, new Date().toISOString(), JSON.stringify(content));
}

describe('extractPromptAttachments', () => {
  it('accepts a host-staged file and binds it to its source message', () => {
    insertChat('m1', {
      text: 'look',
      attachments: [{ name: 'cat.png', mimeType: 'image/png', localPath: 'inbox/m1/cat.png' }],
    });

    expect(extractPromptAttachments(getPendingMessages())).toEqual([
      {
        sourceMessageId: 'm1',
        filename: 'cat.png',
        mime: 'image/png',
        path: '/workspace/inbox/m1/cat.png',
      },
    ]);
  });

  it('preserves association when a batch contains the same filename twice', () => {
    insertChat('m1', { attachments: [{ name: 'image.png', localPath: 'inbox/m1/image.png' }] });
    insertChat('m2', { attachments: [{ name: 'image.png', localPath: 'inbox/m2/image.png' }] });

    expect(extractPromptAttachments(getPendingMessages())).toEqual([
      { sourceMessageId: 'm1', filename: 'image.png', path: '/workspace/inbox/m1/image.png' },
      { sourceMessageId: 'm2', filename: 'image.png', path: '/workspace/inbox/m2/image.png' },
    ]);
  });

  it('rejects traversal, another message inbox, and the group workspace', () => {
    insertChat('m1', {
      attachments: [
        { name: 'secret.pdf', localPath: '../agent/secret.pdf' },
        { name: 'secret.pdf', localPath: 'agent/secret.pdf' },
        { name: 'old.pdf', localPath: 'inbox/m0/old.pdf' },
        { name: '../escape.pdf', localPath: 'inbox/m1/../escape.pdf' },
      ],
    });

    const messages = getPendingMessages();
    expect(extractPromptAttachments(messages)).toEqual([]);
    const prompt = formatMessages(messages);
    expect(prompt).not.toContain('/workspace/agent/secret.pdf');
    expect(prompt).not.toContain('/workspace/inbox/m0/old.pdf');
  });

  it('keeps the canonical staged path in ordinary prompt text', () => {
    insertChat('m1', {
      attachments: [{ name: 'cat.png', localPath: 'inbox/m1/cat.png' }],
    });
    expect(formatMessages(getPendingMessages())).toContain('/workspace/inbox/m1/cat.png');
  });

  it('rejects url-only and unstaged channel metadata', () => {
    insertChat('m1', {
      attachments: [
        { name: 'remote.png', url: 'https://example.test/remote.png' },
        { name: 'claimed.png', mimeType: 'image/png' },
      ],
    });

    expect(extractPromptAttachments(getPendingMessages())).toEqual([]);
  });

  it('requires the host-sanitized name rather than a raw filename field', () => {
    insertChat('m1', {
      attachments: [{ filename: 'raw.png', mimeType: 'image/png', localPath: 'inbox/m1/raw.png' }],
    });
    expect(extractPromptAttachments(getPendingMessages())).toEqual([]);
  });

  it('ignores malformed values without dropping valid siblings', () => {
    insertChat('m1', {
      attachments: [
        null,
        42,
        { name: 7, localPath: 'inbox/m1/7.png' },
        { name: 'ok.png', mimeType: { forged: true }, localPath: 'inbox/m1/ok.png' },
      ],
    });

    const messages = getPendingMessages();
    expect(extractPromptAttachments(messages)).toEqual([
      { sourceMessageId: 'm1', filename: 'ok.png', path: '/workspace/inbox/m1/ok.png' },
    ]);
    expect(() => formatMessages(messages)).not.toThrow();
  });
});
