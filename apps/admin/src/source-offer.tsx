import { useT } from "@kuutti/i18n/react";
import { HealthResponse } from "@kuutti/schema";
import { useEffect, useState } from "react";
import { API_URL, apiUrl } from "./lib/api.ts";

export { apiUrl };

/** Under the screen, quiet: small and muted, its links underlined (ADR-050). */
const FOOTER =
  "mx-auto w-full max-w-6xl space-y-1 border-t px-4 py-6 text-xs text-muted-foreground md:px-8 [&_a]:break-all";

type State = { kind: "loading" } | { kind: "ok"; health: HealthResponse } | { kind: "unknown" };

/**
 * The panel's footer: the source-code offer of AGPL-3.0 section 13 for the
 * panel's users (#16), the address the running API names in /health with its
 * commit, parsed with the shared contract, which admits https addresses only;
 * and in every state the licences of the packages the panel is built from
 * (#416).
 */
export function SourceOffer() {
  const { t } = useT();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    if (API_URL === undefined) {
      setState({ kind: "unknown" });
      return;
    }
    const controller = new AbortController();
    fetch(`${API_URL}/health`, { signal: controller.signal })
      .then(async (response) => HealthResponse.parse(await response.json()))
      .then((health) => setState({ kind: "ok", health }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: "unknown" });
      });
    return () => controller.abort();
  }, []);

  // A plain link: a static file beside the build, outside the router, under
  // the build's base (/pr-<n>/ for a preview).
  const licences = (
    <p>
      <a href={`${import.meta.env.BASE_URL}licenses.txt`}>{t("admin.licenses.link")}</a>
    </p>
  );
  if (state.kind === "loading") {
    return (
      <footer className={FOOTER}>
        <p aria-busy="true" />
        {licences}
      </footer>
    );
  }
  if (state.kind === "unknown") {
    return (
      <footer className={FOOTER}>
        <p>{t("admin.source.unavailable")}</p>
        {licences}
      </footer>
    );
  }
  return (
    <footer className={FOOTER}>
      <p>
        {t("admin.source.offer", { commit: state.health.commit })}{" "}
        <a href={state.health.source} rel="noreferrer noopener" target="_blank">
          {state.health.source}
        </a>
      </p>
      {licences}
    </footer>
  );
}
