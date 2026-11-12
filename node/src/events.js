export function serializeDbTimestamp(value) {
  if (typeof value !== 'string') return value;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value)) return value.replace('.000Z', 'Z');
  const match = value.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/);
  return match ? `${match[1]}T${match[2]}Z` : value;
}

export function createEventBus({ bufferSize = 500, now = () => new Date(), onListenerError = () => {} } = {}) {
  if (!Number.isSafeInteger(bufferSize) || bufferSize < 1) throw new TypeError('bufferSize must be a positive integer');
  const ring = [];
  const listeners = new Set();
  let lastId = 0;

  function normalizeId(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
    throw new TypeError('lastId must be a non-negative integer');
  }
  function copyEvent(event) { return { ...event, data: structuredClone(event.data) }; }

  return {
    emit(type, data) {
      if (typeof type !== 'string' || !/^[A-Za-z0-9_-]+$/.test(type)) throw new TypeError('event type must contain only letters, numbers, underscores, or hyphens');
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('event data must be an object');
      const clonedData = structuredClone(data);
      JSON.stringify(clonedData);
      const timestamp = now();
      const event = {
        id: ++lastId,
        type,
        data: clonedData,
        timestamp: (timestamp instanceof Date ? timestamp : new Date(timestamp)).toISOString(),
      };
      ring.push(event);
      if (ring.length > bufferSize) ring.splice(0, ring.length - bufferSize);
      for (const listener of [...listeners]) {
        try { listener(copyEvent(event)); }
        catch (error) { try { onListenerError(error); } catch { /* Listener reporting must not stop other subscribers. */ } }
      }
      return copyEvent(event);
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      };
    },
    getSince(value) {
      const id = normalizeId(value);
      if (ring.length && id < ring[0].id - 1) return { reset: true };
      return ring.filter((event) => event.id > id).map(copyEvent);
    },
    latestId() { return lastId; },
    listenerCount() { return listeners.size; },
    bufferSize,
  };
}
