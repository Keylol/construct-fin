import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

function showBootFallback(error) {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  const detail = String(error?.message || error || "").trim();
  root.innerHTML = `
    <section class="boot-fallback" role="alert">
      <div class="boot-fallback-kicker">ConstructPC</div>
      <h1>Не удалось открыть приложение</h1>
      <p>Закройте Mini App и откройте его снова. Если экран останется пустым, значит фронт не загрузился полностью.</p>
      ${detail ? `<pre>${detail}</pre>` : ""}
    </section>
  `;
}

window.addEventListener("error", (event) => {
  showBootFallback(event.error || event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  showBootFallback(event.reason);
});

try {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("Корневой контейнер не найден");
  }
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} catch (error) {
  showBootFallback(error);
}
