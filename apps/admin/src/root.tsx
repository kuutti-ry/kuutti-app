import { I18nProvider } from "@kuutti/i18n/react";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./app.tsx";
import { restoreReturnPath, StaffSessionProvider } from "./features/identity/index.ts";
import { i18n } from "./i18n.ts";

/**
 * The panel mounted into the page (#302). The way back from the bank comes
 * first: the remembered path is put back before the router reads the address,
 * so the person lands where the sign-in started and no other screen asks the
 * API for anything on the way.
 */
export function mount(element: HTMLElement): Root {
  restoreReturnPath();
  // A preview is built with Vite's base /pr-<n>/ and served under it (ADR-025
  // §6). The router takes the base without its last slash: it does not match
  // /pr-12 against the basename /pr-12/, and that address opens the preview too.
  const basename = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <I18nProvider i18n={i18n}>
        <StaffSessionProvider>
          <BrowserRouter basename={basename}>
            <App />
          </BrowserRouter>
        </StaffSessionProvider>
      </I18nProvider>
    </StrictMode>,
  );
  return root;
}
