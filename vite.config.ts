import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { proofModeRuntime } from "./server/proofmode-runtime";

export default defineConfig({
  plugins: [react(), proofModeRuntime()],
  server: {
    // Proof artifacts are produced by the runner while Vite is serving the
    // UI. They are evidence, not source; watching them creates noisy reloads
    // during a replay and can interrupt the reviewer request.
    watch: { ignored: ["**/proof-runs/**", "**/proof-exports/**"] },
  },
});
