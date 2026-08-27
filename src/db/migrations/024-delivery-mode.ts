import type { Migration } from './index.js';

/** Optional per-group delivery contract. NULL preserves the envelope default. */
export const migration024: Migration = {
  version: 24,
  name: 'delivery-mode',
  async up(db) {
    await db.exec('ALTER TABLE container_configs ADD COLUMN delivery_mode TEXT;');
  },
};
