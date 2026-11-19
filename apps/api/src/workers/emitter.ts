import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { Server } from 'socket.io';

export interface SocketEmitter {
  /** Broadcasts to every API instance's sockets in `rooms` (through the Redis adapter). */
  emit(rooms: string[], event: string, payload: unknown): void;
  /** False while Redis is unreachable: publishing then would silently drop events. */
  ready(): boolean;
  close(): Promise<void>;
}

/**
 * Socket.IO server with no HTTP listener: it holds no sockets, so emits only go out through
 * the Redis adapter to the API instances that do.
 */
export function createSocketEmitter(
  redisUrl: string,
  onError: (err: Error) => void = () => {},
): SocketEmitter {
  const pub = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const sub = pub.duplicate();
  pub.on('error', onError);
  sub.on('error', onError);
  const io = new Server();
  io.adapter(createAdapter(pub, sub));
  return {
    emit: (rooms, event, payload) => {
      if (rooms.length) io.to(rooms).emit(event, payload);
    },
    ready: () => pub.status === 'ready' && sub.status === 'ready',
    close: async () => {
      // No engine without an HTTP server, so io.close() would throw; release the adapter only.
      await io.of('/').adapter.close();
      await Promise.allSettled([pub.quit(), sub.quit()]);
    },
  };
}
