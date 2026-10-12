import type { PlainMessageKey } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import { useStaffSession } from "./session.tsx";

const ERRORS: ReadonlyMap<string, PlainMessageKey> = new Map([
  ["admin_not_allowed", "admin.signIn.error.admin_not_allowed"],
  ["no_api", "admin.signIn.error.no_api"],
  ["session_ended", "admin.signIn.error.session_ended"],
]);

/** The one thing a signed-out panel shows: the bank login, and the refusal if there was one. */
export function SignIn() {
  const { t } = useT();
  const session = useStaffSession();
  const error = session.status === "signed-out" ? session.error : undefined;
  return (
    <section aria-labelledby="sign-in-title">
      <h2 id="sign-in-title">{t("admin.signIn.title")}</h2>
      <p>{t("admin.signIn.explain")}</p>
      {error && <p role="alert">{t(ERRORS.get(error) ?? "admin.signIn.error.generic")}</p>}
      <button type="button" onClick={session.signIn} disabled={error === "no_api"}>
        {t("admin.signIn.button")}
      </button>
    </section>
  );
}
