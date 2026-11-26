import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import { Toaster } from "sonner";
import { App } from "./App";
import { AuthProvider } from "./lib/auth";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </HashRouter>
    <Toaster position="bottom-right" richColors closeButton />
  </StrictMode>,
);
