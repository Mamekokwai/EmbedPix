export type WindowCloseHandler = () => void | Promise<void>;

const CLOSE_WAIT_TIMEOUT_MS = 1500;
const handlers = new Set<WindowCloseHandler>();
let closeRequest: Promise<void> | null = null;

export function registerWindowCloseHandler(handler: WindowCloseHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function requestWindowClose(): Promise<void> {
  if (closeRequest) return closeRequest;
  const pending = Array.from(handlers, (handler) => Promise.resolve().then(handler));
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
