import { useQueryClient } from '@tanstack/react-query';
import {
  parseRoom,
  type RoomAck,
  SocketCommand,
  type SocketEvent,
  type SocketEventPayload,
} from '@ebalangay/shared';
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { keysForRoom } from './query-keys.js';
import { type AppSocket, keysForEvent, parseSocketPayload, VersionTracker } from './socket.js';

const SocketContext = createContext<{ socket: AppSocket; versions: VersionTracker } | null>(null);

export function SocketProvider({ socket, children }: { socket: AppSocket; children: ReactNode }) {
  const [versions] = useState(() => new VersionTracker());
  const qc = useQueryClient();

  // Anything may have changed while disconnected: refetch active queries on reconnect.
  useEffect(() => {
    const onReconnect = () => void qc.invalidateQueries({ refetchType: 'active' });
    socket.io.on('reconnect', onReconnect);
    return () => {
      socket.io.off('reconnect', onReconnect);
    };
  }, [socket, qc]);

  return <SocketContext.Provider value={{ socket, versions }}>{children}</SocketContext.Provider>;
}

function useSocketContext() {
  const ctx = useContext(SocketContext);
  if (!ctx) throw new Error('Socket hooks must be used inside <SocketProvider>');
  return ctx;
}

export function useSocket(): AppSocket {
  return useSocketContext().socket;
}

export function useSocketConnected(): boolean {
  const socket = useSocket();
  const [connected, setConnected] = useState(socket.connected);
  useEffect(() => {
    const on = () => setConnected(true);
    const off = () => setConnected(false);
    socket.on('connect', on);
    socket.on('disconnect', off);
    return () => {
      socket.off('connect', on);
      socket.off('disconnect', off);
    };
  }, [socket]);
  return connected;
}

/**
 * Join a room (e.g. Rooms.order(id)) while mounted. Re-joins after every reconnect and
 * invalidates that room's queries, since events may have been missed. Pass null to skip.
 */
export function useSocketRoom(room: string | null, onError?: (error: string) => void): void {
  const socket = useSocket();
  const qc = useQueryClient();
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });

  useEffect(() => {
    if (!room) return;
    let joinedBefore = false;
    const join = () => {
      socket.emit(SocketCommand.JOIN, { room }, (ack: RoomAck | undefined) => {
        if (ack && !ack.ok) onErrorRef.current?.(ack.error ?? 'FORBIDDEN');
      });
      if (joinedBefore) {
        const parsed = parseRoom(room);
        for (const queryKey of parsed ? keysForRoom(parsed.kind, parsed.id) : []) {
          void qc.invalidateQueries({ queryKey });
        }
      }
      joinedBefore = true;
    };
    if (socket.connected) join();
    socket.on('connect', join);
    return () => {
      socket.off('connect', join);
      if (socket.connected) socket.emit(SocketCommand.LEAVE, { room });
    };
  }, [socket, qc, room]);
}

/**
 * Subscribe to a server event. Payloads are validated, stale versions dropped, and the
 * related queries invalidated (disable with `invalidate: false`).
 */
export function useSocketEvent<E extends SocketEvent>(
  event: E,
  handler?: (payload: SocketEventPayload<E>) => void,
  options: { invalidate?: boolean } = {},
): void {
  const { socket, versions } = useSocketContext();
  const qc = useQueryClient();
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  const invalidate = options.invalidate ?? true;

  useEffect(() => {
    const listener = (raw: unknown) => {
      const payload = parseSocketPayload(event, raw);
      if (!payload || !versions.accept(event, payload)) return;
      handlerRef.current?.(payload);
      if (invalidate) {
        for (const queryKey of keysForEvent(event, payload))
          void qc.invalidateQueries({ queryKey });
      }
    };
    socket.on(event as string, listener);
    return () => {
      socket.off(event as string, listener);
    };
  }, [socket, versions, qc, event, invalidate]);
}
