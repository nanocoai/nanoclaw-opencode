import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { LINK_ACTION_SCHEMA, sendCard } from './interactive.js';

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
    expect(result.content[0].text).toContain('2 invalid action(s) were dropped');
    expect(result.content[0].text).toContain('ask_user_question');
    // Only renderable actions reach the payload, so the count and the row agree.
    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content.type).toBe('card');
    expect(content.card.actions).toEqual([{ label: 'Docs', url: 'https://example.com' }]);
  });

  it('drops a null action instead of writing something the bridge cannot read', async () => {
    const result = await sendCard.handler({
      card: { title: 'Test', actions: [null, { label: 'Docs', url: 'https://example.com' }] },
    });

    expect(result.content[0].text).toContain('1 invalid action(s) were dropped');
    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content.card.actions).toEqual([{ label: 'Docs', url: 'https://example.com' }]);
  });

  // The bridge maps any unrecognized style to the default button styling, so a
  // bad style must never cost the agent the whole button. `null` is the case
  // that matters: it is how a model most often fills an optional field.
  it.each([['chartreuse'], [null], [5], [true]])(
    'keeps an action whose style is %p, for the bridge to fall back on',
    async (style) => {
      const result = await sendCard.handler({
        card: { title: 'Test', actions: [{ label: 'Docs', url: 'https://example.com', style }] },
      });

      expect(result.content[0].text).toMatch(/^Card sent \(id: msg-[^)]+\)$/);
      const content = JSON.parse(getUndeliveredMessages()[0].content);
      expect(content.card.actions).toEqual([{ label: 'Docs', url: 'https://example.com', style }]);
    },
  );

  it('drops an action whose label is empty, the rule the schema owns', async () => {
    const result = await sendCard.handler({
      card: { title: 'Test', actions: [{ label: '', url: 'https://example.com' }] },
    });

    expect(result.content[0].text).toContain('1 invalid action(s) were dropped');
    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content.card.actions).toEqual([]);
  });

  it('leaves an empty or non-array actions value exactly as the bridge would', async () => {
    await sendCard.handler({ card: { title: 'Empty', actions: [] } });
    await sendCard.handler({ card: { title: 'Bogus', actions: 'nope' } });

    const [empty, bogus] = getUndeliveredMessages().map((m) => JSON.parse(m.content));
    expect(empty.card.actions).toEqual([]);
    expect(bogus.card.actions).toBe('nope');
  });

  it('advertises the same action schema it enforces', () => {
    const cardSchema = sendCard.tool.inputSchema.properties.card as {
      properties: { actions: { items: unknown } };
    };

    expect(cardSchema.properties.actions.items).toBe(LINK_ACTION_SCHEMA);
  });

  it('tells the agent when a URL action has no label', async () => {
    const result = await sendCard.handler({
      card: { title: 'Test', actions: [{ url: 'https://example.com' }] },
    });

    expect(result.content[0].text).toContain('1 invalid action(s) were dropped');
    expect(result.content[0].text).toContain('absolute url');
  });

  // A model asked for an approval card cannot make a callback button, so it
  // fakes one with a placeholder href. Dropping it points the agent at
  // ask_user_question instead of posting two dead links.
  it.each([['#'], ['/docs'], ['example.com'], ['   ']])('drops a link action whose url is %p', async (url) => {
    const result = await sendCard.handler({
      card: { title: 'Test Approval Card', actions: [{ label: 'Approve', url }] },
    });

    expect(result.content[0].text).toContain('1 invalid action(s) were dropped');
    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content.card.actions).toEqual([]);
  });

  it.each([['https://example.com'], ['http://localhost:3000/x'], ['mailto:someone@example.com'], ['tel:+34600000000']])(
    'keeps a link action whose url is %p',
    async (url) => {
      const result = await sendCard.handler({ card: { title: 'Test', actions: [{ label: 'Open', url }] } });

      expect(result.content[0].text).toMatch(/^Card sent \(id: msg-[^)]+\)$/);
      const content = JSON.parse(getUndeliveredMessages()[0].content);
      expect(content.card.actions).toEqual([{ label: 'Open', url }]);
    },
  );

  it('constrains children to text instead of promising nested action blocks', () => {
    const cardSchema = sendCard.tool.inputSchema.properties.card as {
      properties: { children: { description: string; items: { anyOf: Array<Record<string, unknown>> } } };
    };

    expect(cardSchema.properties.children.description).toContain('Nested action blocks are unsupported');
    expect(cardSchema.properties.children.items.anyOf).toHaveLength(2);
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
