import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { sendCard } from './interactive.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('send_card', () => {
  it('tells the agent when callback actions will be dropped', async () => {
    const result = await sendCard.handler({
      card: {
        title: 'Test',
        actions: [
          { label: 'Approve', value: 'approve' },
          { label: 'Reject', value: 'reject' },
          { label: 'Docs', url: 'https://example.com' },
        ],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('2 action(s) without a url were dropped');
    expect(result.content[0].text).toContain('ask_user_question');
    // The payload itself is unchanged: the bridge decides what renders.
    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content.type).toBe('card');
    expect(content.card.actions).toHaveLength(3);
  });

  it('stays quiet when every action has a url', async () => {
    const result = await sendCard.handler({
      card: { title: 'Test', actions: [{ label: 'Docs', url: 'https://example.com' }] },
    });

    expect(result.content[0].text).toMatch(/^Card sent \(id: msg-[^)]+\)$/);
  });

  it('stays quiet for display-only cards', async () => {
    const result = await sendCard.handler({ card: { title: 'Test', description: 'No actions' } });

    expect(result.content[0].text).toMatch(/^Card sent \(id: msg-[^)]+\)$/);
  });
});
