/**
 * PreCompact hook script — outputs custom compaction instructions to stdout.
 *
 * Claude Code captures the stdout of PreCompact shell hooks and passes it
 * as `customInstructions` to the compaction prompt. This ensures the
 * compaction summary preserves message routing context that the agent needs
 * to correctly address responses.
 *
 * Invoked by the PreCompact hook in .claude-shared/settings.json:
 *   "command": "bun /app/src/compact-instructions.ts"
 */
import { getAllDestinations } from './destinations.js';
import { loadConfig, type DeliveryMode } from './config.js';
import { getTaskSeriesId } from './db/session-routing.js';

/**
 * The delivery-contract sentences every "context was just rebuilt" path
 * re-states: the closing reminder of the compaction summary here, and the
 * OpenCode provider's first prompt after an SDK-side auto-compaction
 * (`providers/opencode.ts`). One source, so the two paths cannot drift on
 * what actually delivers in this session — which is decided by the poll-loop,
 * not by the provider.
 */
export function buildDeliveryReminder(
  names: string[],
  taskId: string | null,
  deliveryMode: DeliveryMode = 'envelope',
): string[] {
  const destinations = `Available destinations: ${formatDestinationNames(names)}.`;
  if (taskId) {
    return [
      'This is an isolated task run. If you need to send the user a message, use send_message with an explicit to destination.',
      `Final output is not delivered; it becomes the automatic summary in tasks/${taskId}.md.`,
      destinations,
    ];
  }
  if (deliveryMode === 'tools-only') {
    return [
      'Only real outbound tool calls deliver. Response prose and <message> blocks are private scratchpad.',
      destinations,
    ];
  }
  return ['You MUST wrap all responses in <message to="name">...</message> blocks.', destinations];
}

export function buildCompactInstructions(
  names: string[],
  taskId: string | null,
  deliveryMode: DeliveryMode = 'envelope',
): string {
  // Rendered as one quoted, indented block for the compaction prompt.
  const reminder = buildDeliveryReminder(names, taskId, deliveryMode);
  const deliveryReminder = reminder.map(
    (line, index) => `   ${index === 0 ? '"' : ''}${line}${index === reminder.length - 1 ? '"' : ''}`,
  );

  return [
    'Preserve the following in the compaction summary:',
    '',
    '1. For recent messages, keep the full XML structure including all attributes:',
    '   - <message from="..." sender="..." time="..."> for chat messages',
    '   - <task from="..." time="..." current_time="..."> for scheduled tasks',
    '   - <webhook from="..." source="..." event="..."> for webhooks',
    '   The message content can be summarized if long, but the XML tags and attributes must remain.',
    '',
    '2. Preserve the chronological message/reply sequence of recent exchanges.',
    '   The agent needs to see: who said what, in what order, and from which destination.',
    '',
    '3. At the END of the compaction summary, include this verbatim reminder:',
    ...deliveryReminder,
  ].join('\n');
}

function formatDestinationNames(names: string[]): string {
  return names.length > 0 ? names.map((name) => `\`${name}\``).join(', ') : '(none)';
}

if (import.meta.main) {
  const names = getAllDestinations().map((destination) => destination.name);
  console.log(buildCompactInstructions(names, getTaskSeriesId(), loadConfig().deliveryMode));
}
