import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App, { enforceReaderFlag } from "./App.jsx";
import "./styles.css";

if (enforceReaderFlag()) {
  createRoot(document.getElementById("root")).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
