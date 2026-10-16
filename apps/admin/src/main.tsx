import "./styles.css";
import { I18nProvider } from "@kuutti/i18n/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./app.tsx";
import { restoreReturnPath, StaffSessionProvider } from "./features/identity/index.ts";
import { i18n } from "./i18n.ts";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
// Before the router reads the address: back to where the bank login started (#302).
restoreReturnPath();
createRoot(root).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <StaffSessionProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </StaffSessionProvider>
    </I18nProvider>
  </StrictMode>,
);
