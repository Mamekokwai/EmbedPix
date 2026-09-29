export interface WindowListenerLifecycle {
  disposed: boolean;
}

export function retainWindowListener(
  lifecycle: WindowListenerLifecycle,
  saveCleanup: (cleanup: () => void) => void,
  cleanup: () => void,
): void {
  if (lifecycle.disposed) cleanup();
  else saveCleanup(cleanup);
}
