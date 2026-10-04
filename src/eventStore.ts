import { EventEmitter } from "node:events";
import type { MessageRow } from "./types.js";
import type { ErrorFrame, ReadReceiptFrame, ServerAckFrame } from "./protocol.js";

/** Typed UI/transport bus. Replaces the stringly-typed global emitter. */
export type BusEvents = {
  /** UI intent: user submitted plaintext for a peer (handled by the outbox sender). */
  send_message: [text: string];
  /** Server accepted a send (mark sent). */
  send_ack: [msg: ServerAckFrame];
  /** Decoded inbound message (append to thread). */
  incoming_message: [msg: MessageRow];
  /** Unknown sender auto-added (refresh sidebar). */
  new_contact: [];
  /** Sidebar membership changed (open/close/delete). */
  chats_changed: [];
  /** Session identified (outbox flush done elsewhere; UI refresh). */
  identified: [];
  /** Transport state for the header. */
  connection: [online: boolean];
  /** Sender-side read notification (mark read). */
  read_receipt: [msg: ReadReceiptFrame];
  /** Coded server error (log/toast; connection stays up). */
  server_error: [msg: ErrorFrame];
};

type Handler<T extends unknown[]> = (...args: T) => void;

class TypedBus {
  private ee = new EventEmitter();

  on<K extends keyof BusEvents>(event: K, handler: Handler<BusEvents[K]>): void {
    this.ee.on(event, handler as (...args: unknown[]) => void);
  }

  off<K extends keyof BusEvents>(event: K, handler: Handler<BusEvents[K]>): void {
    this.ee.off(event, handler as (...args: unknown[]) => void);
  }

  emit<K extends keyof BusEvents>(event: K, ...args: BusEvents[K]): void {
    this.ee.emit(event, ...args);
  }
}

export const socketBus = new TypedBus();
