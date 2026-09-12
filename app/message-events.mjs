const subscribers = new Set();

export function subscribeToMessagingEvents(listener) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export function publishMessagingEvent(event) {
  for (const listener of subscribers) {
    try {
      listener(event);
    } catch {
      // A broken subscriber must never stop the webhook from completing.
    }
  }
}

