// Typed pub/sub event bus. Events are a discriminated union on `type`;
// subscribing to a type narrows the handler's payload automatically.

type EventOf<E, K> = Extract<E, { type: K }>;

export class EventBus<E extends { type: string }> {
  private handlers = new Map<E["type"], Set<(event: E) => void>>();

  /** Subscribe to one event type. Returns an unsubscribe function. */
  on<K extends E["type"]>(type: K, handler: (event: EventOf<E, K>) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const fn = handler as (event: E) => void;
    set.add(fn);
    return () => set.delete(fn);
  }

  emit(event: E): void {
    const set = this.handlers.get(event.type);
    if (!set) return;
    for (const fn of set) fn(event);
  }
}
