export type WindowCloseHandler = () => void | Promise<void>;

const CLOSE_WAIT_TIMEOUT_MS = 1500;
const handlers = new Map<WindowCloseHandler, { active: boolean; inFlight: Promise<void> | null }>();
let closeRequest: Promise<void> | null = null;

export function registerWindowCloseHandler(handler: WindowCloseHandler): () => void {
  const state = { active: true, inFlight: null as Promise<void> | null };
  handlers.set(handler, state);
  return () => {
    state.active = false;
    if (!state.inFlight) handlers.delete(handler);
  };
}

export function requestWindowClose(): Promise<void> {
  if (closeRequest) return closeRequest;
  const pending = Array.from(handlers.entries()).filter(([, state]) => state.active).map(([handler, state]) => {
    if (!state.inFlight) {
      state.inFlight = Promise.resolve().then(handler).finally(() => {
        state.inFlight = null;
        if (!state.active) handlers.delete(handler);
      });
    }
    return state.inFlight;
  });
  closeRequest = Promise.race([
    Promise.allSettled(pending).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, CLOSE_WAIT_TIMEOUT_MS)),
  ]).finally(() => {
    closeRequest = null;
  });
  return closeRequest;
}

export function resetWindowCloseCoordinatorForTests(): void {
  handlers.clear();
  closeRequest = null;
}
