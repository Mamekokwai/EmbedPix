import { useEffect, useState, type MouseEvent } from "react";
import { Maximize2, Minimize2, Minus, X } from "lucide-react";
import {
  closeCurrentWindow,
  minimizeCurrentWindow,
  readCurrentWindowMaximized,
  startCurrentWindowDrag,
  toggleCurrentWindowMaximized,
  watchCurrentWindowMaximized,
} from "../platform/window/windowControlGateway";

const APP_TITLE = "EmbedPix";

function runWindowAction(action: () => Promise<void>, actionName: string) {
  void action().catch((error) => {
    console.warn(`${actionName} failed`, error);
  });
}

export default function AppTitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    try {
      void readCurrentWindowMaximized().then(setIsMaximized).catch(() => undefined);
      void watchCurrentWindowMaximized(setIsMaximized).then((unlisten) => {
        cleanup = unlisten;
      }).catch(() => undefined);
    } catch {
      // The browser preview does not expose Tauri window controls.
    }
    return () => cleanup?.();
  }, []);

  const handleDragMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.detail > 1) return;
    runWindowAction(startCurrentWindowDrag, "start window drag");
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

      <div className="app-titlebar-controls">
        <button
          type="button"
          className="app-titlebar-button"
          aria-label="最小化"
          onClick={() => runWindowAction(minimizeCurrentWindow, "minimize current window")}
        >
          <Minus size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="app-titlebar-button"
          aria-label={isMaximized ? "还原窗口" : "最大化"}
          onClick={() => runWindowAction(toggleCurrentWindowMaximized, "toggle window maximize")}
        >
          {isMaximized ? <Minimize2 size={13} strokeWidth={2} /> : <Maximize2 size={13} strokeWidth={2} />}
        </button>
        <button
          type="button"
          className="app-titlebar-button app-titlebar-close"
          aria-label="关闭"
          onClick={() => runWindowAction(closeCurrentWindow, "close current window")}
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
    </header>
  );
}
