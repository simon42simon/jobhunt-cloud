import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Frontend dev server. /api (incl. the SSE stream) is proxied to the local
// Express file-bridge so the browser can read/write the vault's Markdown files.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    open: true,
    // Loopback only by default (local-first posture): the dev server is not
    // reachable from the LAN. Exposing it to a phone over the Tailscale overlay
    // (ADR-018 R2) is a deliberate re-enable. NOTE: keep `host` on loopback -
    // `tailscale serve` runs on this machine and proxies the tailnet request to
    // 127.0.0.1:5180 locally, so the dev server must NOT bind 0.0.0.0 (that would
    // expose it on the LAN and defeat the loopback posture). We only need to
    // accept the overlay's Host header, so the ts.net hostname is added to
    // allowedHosts (the reachability set is still just loopback + the tailnet
    // ACL that permits owner devices -> galena:443).
    host: "127.0.0.1",
    allowedHosts: ["localhost", "127.0.0.1", "galena.tail30b7b8.ts.net"],
    // The Express file-bridge writes app-managed DATA under docs/ (tasks.yaml,
    // requests.yaml, portfolio.yaml, discovery-sources.yaml, the activity log,
    // telemetry) and logs under ops/outputs/. None of these are part of the
    // module graph, so a write here made Vite trigger a FULL PAGE RELOAD - which
    // reset the SPA to its default view and yanked the user out of (e.g.) the
    // Discovery Sources console mid-edit. The app already gets its own data
    // freshness from the /api/stream SSE, so Vite has no reason to watch these:
    // ignore them so an in-app write never reloads the page (t-1783207327063).
    watch: {
      ignored: ["**/docs/**", "**/ops/outputs/**"],
    },
    proxy: {
      // JOBHUNT_PROXY_TARGET lets a second Vite point at an isolated backend
      // (e.g. a branch instance on :8788 via JOBHUNT_PORT) for parallel-instance
      // live-verify without touching the owner's running :8787. Default unchanged.
      "/api": {
        target: process.env.JOBHUNT_PROXY_TARGET || "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  test: {
    // A nested git worktree (`.claude/worktrees/<branch>`, used for isolated
    // parallel work) is a full second checkout of this repo. Without this
    // exclude, vitest discovers and runs ITS test files too - double-running the
    // suite and coupling this tree's gate to the worktree's in-flight state (a
    // transient failure in a sibling worktree would wrongly block this tree's
    // push). Never run another checkout's tests from this one.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
