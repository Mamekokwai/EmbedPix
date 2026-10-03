import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Maximize2, Minimize2, Minus, X } from "lucide-react";
import {
  closeCurrentWindow,
  destroyCurrentWindow,
  minimizeCurrentWindow,
  readCurrentWindowMaximized,
  startCurrentWindowDrag,
  toggleCurrentWindowMaximized,
  watchCurrentWindowCloseRequested,
  watchCurrentWindowMaximized,
} from "../platform/window/windowControlGateway";
import { requestWindowClose } from "../platform/window/windowCloseCoordinator";
import { retainWindowListener } from "../platform/window/windowListenerLifecycle";

const APP_TITLE = "EmbedPix";
const WINDOW_DESTROY_TIMEOUT_MS = 1500;

async function destroyWindowWithTimeout(): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      destroyCurrentWindow(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("destroy current window timed out")), WINDOW_DESTROY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function runWindowAction(action: () => Promise<void>, actionName: string) {
  void action().catch((error) => {
    console.warn(`${actionName} failed`, error);
  });
}

export default function AppTitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeFlowStartedRef = useRef(false);
  const nativeCloseHandledRef = useRef(false);

  const finishWindowClose = () => {
    nativeCloseHandledRef.current = true;
    void requestWindowClose().then(async () => {
      try {
        await destroyWindowWithTimeout();
      } catch (destroyError) {
        // Older installed builds may not have the destroy capability; close remains a safe fallback because the event is already acknowledged.
        console.warn("destroy current window failed, falling back to close", destroyError);
        await closeCurrentWindow();
      }
    }).catch((error) => {
      nativeCloseHandledRef.current = false;
      closeFlowStartedRef.current = false;
      setClosing(false);
      console.warn("close current window failed", error);
    });
  };

  useEffect(() => {
    const lifecycle = { disposed: false };
    let maximizedCleanup: (() => void) | undefined;
    let closeCleanup: (() => void) | undefined;
    try {
      void readCurrentWindowMaximized().then((maximized) => {
        if (!lifecycle.disposed) setIsMaximized(maximized);
      }).catch(() => undefined);
      void watchCurrentWindowMaximized((maximized) => {
        if (!lifecycle.disposed) setIsMaximized(maximized);
      }).then((unlisten) => {
        retainWindowListener(lifecycle, (cleanup) => { maximizedCleanup = cleanup; }, unlisten);
      }).catch(() => undefined);
      void watchCurrentWindowCloseRequested((event) => {
        if (lifecycle.disposed) return;
        if (nativeCloseHandledRef.current) return;
        event.preventDefault();
        nativeCloseHandledRef.current = true;
        setClosing(true);
        finishWindowClose();
      }).then((unlisten) => {
        retainWindowListener(lifecycle, (cleanup) => { closeCleanup = cleanup; }, unlisten);
      }).catch(() => undefined);
    } catch {
      // The browser preview does not expose Tauri window controls.
    }
    return () => {
      lifecycle.disposed = true;
      maximizedCleanup?.();
      closeCleanup?.();
    };
  }, []);

  const handleDragMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.detail > 1) return;
    runWindowAction(startCurrentWindowDrag, "start window drag");
  };

  const handleClose = () => {
    if (closeFlowStartedRef.current) return;
    closeFlowStartedRef.current = true;
    setClosing(true);
    finishWindowClose();
  };

  return (
    <header className="app-titlebar" aria-label={APP_TITLE}>
      <div className="app-titlebar-brand">
        <span className="app-titlebar-mark" aria-hidden="true">
          <img src="/embedpix-icon.png" alt="" draggable={false} />
        </span>
        <span className="app-titlebar-name">{APP_TITLE}</span>
      </div>

      <div
        className="app-titlebar-drag-region"
        onMouseDown={handleDragMouseDown}
        onDoubleClick={() => runWindowAction(toggleCurrentWindowMaximized, "toggle window maximize")}
      />

      <span className="app-titlebar-author" title="作者：Nywerya / XUNCHANG WANG">
        Nywerya
      </span>

      <div className="app-titlebar-controls">
        <button
          type="button"
          className="app-titlebar-button"
          aria-label="最小化"
          disabled={closing}
          onClick={() => runWindowAction(minimizeCurrentWindow, "minimize current window")}
        >
          <Minus size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="app-titlebar-button"
          aria-label={isMaximized ? "还原窗口" : "最大化"}
          disabled={closing}
          onClick={() => runWindowAction(toggleCurrentWindowMaximized, "toggle window maximize")}
        >
          {isMaximized ? <Minimize2 size={13} strokeWidth={2} /> : <Maximize2 size={13} strokeWidth={2} />}
        </button>
        <button
          type="button"
          className="app-titlebar-button app-titlebar-close"
          aria-label={closing ? "正在关闭" : "关闭"}
          aria-busy={closing}
          disabled={closing}
          onClick={handleClose}
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
    </header>
  );
}
