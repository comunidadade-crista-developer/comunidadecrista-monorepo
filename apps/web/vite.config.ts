import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    // O alvo por omissão do Vite 6 inclui `safari14`, que o esbuild 0.28 já não consegue compilar
    // (destructuring em Safari <= 14.0, iOS <= 14.4). `safari14.1` (iOS 14.5+, iPhone 6s e
    // posteriores) é o mínimo que compila; os outros valores abrangem Android antigo.
    target: ["es2020", "chrome80", "edge80", "firefox78", "safari14.1"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
