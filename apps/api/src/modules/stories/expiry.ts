import type { Logger } from 'pino';
import type { Db } from '../../db.js';
import type { Storage } from '../../lib/storage.js';

export const STORY_EXPIRY_BATCH_SIZE = 200;

/** R2 key of an object we serve from the public bucket; null for foreign URLs. */
export function publicKeyOf(storage: Storage, url: string): string | null {
  const base = storage.publicUrl('');
  return url.startsWith(base) && url.length > base.length ? url.slice(base.length) : null;
}

/**
 * Deletes expired stories, then their media. Rows go first: a failed object delete only leaves
 * an orphan in R2, never a story pointing at missing media.
 */
export async function expireStories(
  deps: { db: Db; storage: Storage; log?: Logger },
  now = new Date(),
): Promise<{ deleted: number }> {
  const { db, storage } = deps;
  let deleted = 0;
  for (;;) {
    const batch = await db.story.findMany({
      where: { expiresAt: { lte: now } },
      select: { id: true, mediaUrl: true },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: STORY_EXPIRY_BATCH_SIZE,
    });
    if (!batch.length) break;
    const { count } = await db.story.deleteMany({ where: { id: { in: batch.map((s) => s.id) } } });
    deleted += count;
    const keys = batch.map((s) => publicKeyOf(storage, s.mediaUrl)).filter((k) => k !== null);
    if (keys.length) {
      await storage.remove('public', keys).catch((err: unknown) => {
        deps.log?.warn({ err, count: keys.length }, 'story media cleanup failed');
      });
    }
    if (batch.length < STORY_EXPIRY_BATCH_SIZE) break;
  }
  return { deleted };
}
