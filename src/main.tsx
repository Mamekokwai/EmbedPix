import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// 桌面应用不需要网页右键菜单；输入框内保留，否则连复制粘贴一起没掉。
document.addEventListener("contextmenu", (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, [contenteditable='true']")) return;
  event.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
