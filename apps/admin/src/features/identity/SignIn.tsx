import type { PlainMessageKey } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import { Landmark } from "lucide-react";
import { useLocation } from "react-router";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Card, CardContent } from "../../components/ui/card.tsx";
import { rememberReturnPath } from "./return-path.ts";
import { useStaffSession } from "./session.tsx";

// The sign-in's rate limit refuses a start through the fragment and an
// exchange with a 429 (ADR-026 §4): one text for both, since both ask for the
// same wait.
const ERRORS: ReadonlyMap<string, PlainMessageKey> = new Map([
  ["admin_not_allowed", "admin.signIn.error.admin_not_allowed"],
  ["no_api", "admin.signIn.error.no_api"],
  ["session_ended", "admin.signIn.error.session_ended"],
  ["auth_rate_limited", "admin.signIn.error.auth_rate_limited"],
  ["rate_limited", "admin.signIn.error.auth_rate_limited"],
]);

/**
 * The one thing a signed-out panel shows, on whatever path it was asked for:
 * the bank login, and the refusal if there was one. The path is remembered
 * for the bank's return (#302).
 */
export function SignIn() {
  const { t } = useT();
  const session = useStaffSession();
  const location = useLocation();
  const error = session.status === "signed-out" ? session.error : undefined;
  return (
    <Card className="mx-auto mt-4 max-w-md md:mt-12">
      <CardContent className="gap-4">
        <section aria-labelledby="sign-in-title" className="space-y-4">
          <h2 id="sign-in-title" className="text-2xl font-semibold tracking-tight">
            {t("admin.signIn.title")}
          </h2>
          <p className="text-muted-foreground">{t("admin.signIn.explain")}</p>
          {error && <Alert>{t(ERRORS.get(error) ?? "admin.signIn.error.generic")}</Alert>}
          <Button
            className="w-full"
            onClick={() => {
              rememberReturnPath(location);
              session.signIn();
            }}
            disabled={error === "no_api"}
          >
            <Landmark aria-hidden="true" />
            {t("admin.signIn.button")}
          </Button>
        </section>
      </CardContent>
    </Card>
  );
}
