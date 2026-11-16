import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installGlobalErrorReporting } from "./lib/clientLog";
import { initTheme } from "./lib/theme";

installGlobalErrorReporting();
initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary area="the app">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
