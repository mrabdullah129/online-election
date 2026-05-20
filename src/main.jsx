import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

try {
  const root = createRoot(document.getElementById("root"));
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} catch (err) {
  const root = document.getElementById("root");
  if (root) {
    root.innerText = `App failed to render: ${err?.message || String(err)}`;
  }
  console.error("App render error:", err);
}
