import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the built bundle works when wrapped by Capacitor (file://) later.
  base: "./",
  server: {
    host: true,
  },
});
