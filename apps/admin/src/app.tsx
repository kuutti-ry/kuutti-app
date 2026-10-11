import { formatTime } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import { SignIn, useStaffSession } from "./features/identity/index.ts";
import { PhotoQueue } from "./features/media/index.ts";
import mark from "./logo-mark.png";
import { SourceOffer } from "./source-offer.tsx";

// The moderation panel (#49, rules/admin.md): a staff bank login, then the
// photo review queue. English only by decision (TD-17); plain React, so the
// component-library question of rules/admin.md stays open.
export function App() {
  const { t, locale } = useT();
  const session = useStaffSession();
  return (
    <>
      <header className="masthead">
        {/* The mark is decorative: the heading right under it carries the name. */}
        <img src={mark} alt="" width={48} height={48} />
        <h1>{t("admin.title")}</h1>
        {session.status === "signed-in" && (
          <p className="session">
            {t("admin.session.role", { role: session.session.role })} ·{" "}
            {t("admin.session.expires", {
              time: formatTime(locale, new Date(session.session.expiresAt)),
            })}{" "}
            <button type="button" onClick={() => void session.signOut()}>
              {t("admin.signOut")}
            </button>
          </p>
        )}
      </header>
      <main>
        {session.status === "loading" && <p aria-busy="true">{t("admin.queue.loading")}</p>}
        {session.status === "signed-out" && <SignIn />}
        {session.status === "signed-in" &&
          (session.session.role === "researcher" ? <p>{t("admin.forbidden")}</p> : <PhotoQueue />)}
      </main>
      <SourceOffer />
    </>
  );
}
