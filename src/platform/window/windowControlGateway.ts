import { getCurrentWindow } from "@tauri-apps/api/window";

function currentWindow() {
  return getCurrentWindow();
}

export async function minimizeCurrentWindow(): Promise<void> {
  await currentWindow().minimize();
}

export async function toggleCurrentWindowMaximized(): Promise<void> {
  await currentWindow().toggleMaximize();
}

export async function closeCurrentWindow(): Promise<void> {
  await currentWindow().close();
}

export async function startCurrentWindowDrag(): Promise<void> {
  await currentWindow().startDragging();
}

export async function readCurrentWindowMaximized(): Promise<boolean> {
  return currentWindow().isMaximized();
}

export async function watchCurrentWindowMaximized(
  handler: (maximized: boolean) => void,
): Promise<() => void> {
  const window = currentWindow();
  const sync = () => {
    void window.isMaximized().then(handler).catch((error) => {
      console.warn("read current window maximized state failed", error);
    });
  };

  sync();
  return window.onResized(sync);
}
