import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// GitHub Pages can briefly serve an older entry bundle after a deployment.
// Recover once from stale/missing lazy-loaded chunks instead of leaving a blank page.
const preloadRetryKey = `vite-preload-retry:${window.location.pathname}`;
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();

  try {
    const previousAttempt = Number(window.sessionStorage.getItem(preloadRetryKey) || "0");
    const now = Date.now();

    // Prevent an infinite reload loop if the deployment itself is inconsistent.
    if (previousAttempt && now - previousAttempt < 60_000) {
      console.error("A lazy-loaded page chunk is still unavailable after reload.", event);
      return;
    }

    window.sessionStorage.setItem(preloadRetryKey, String(now));
    window.location.reload();
  } catch (error) {
    // Storage may be blocked in privacy modes; report the chunk failure without crashing startup.
    console.error("Unable to recover from a lazy-loaded chunk failure.", error, event);
  }
});

createRoot(document.getElementById("root")!).render(<App />);
