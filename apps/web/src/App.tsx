import { APP_AUTHOR, APP_NAME } from "@comunidade/shared";

export function App() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
      <h1>{APP_NAME}</h1>
      <p>Scaffold E0 — fundação pronta.</p>
      <footer>Por {APP_AUTHOR}</footer>
    </main>
  );
}
