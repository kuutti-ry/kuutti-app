import { formatTime, type PlainMessageKey } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import type { ModeratorRole } from "@kuutti/schema";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation } from "react-router";
import { SignIn, useStaffSession } from "./features/identity/index.ts";
import { PhotoQueue } from "./features/media/index.ts";
import { ConfigList, FeedbackList } from "./features/safety/index.ts";
import { setRoleAnswerHandler } from "./lib/api.ts";
import { NavigationFocus, ScreenTitle } from "./lib/screen-title.tsx";
import mark from "./logo-mark.png";
import { SourceOffer } from "./source-offer.tsx";

// The moderation panel (#49, #302, rules/admin.md): a staff bank login, then
// one screen per path with a menu of what the role opens. English only by
// decision (TD-17); plain React with react-router's declarative routes and
// the one CSS file (the component decision of rules/admin.md).

type Screen = {
  path: string;
  label: PlainMessageKey;
  /** The roles the menu shows it to; the API's own guard is what refuses the rest. */
  roles: readonly ModeratorRole[];
  element: ReactNode;
};

const SCREENS: readonly Screen[] = [
  {
    path: "/photos",
    label: "admin.nav.photos",
    roles: ["moderator", "admin"],
    element: <PhotoQueue />,
  },
  {
    path: "/feedback",
    label: "admin.nav.feedback",
    roles: ["moderator", "admin"],
    element: <FeedbackList />,
  },
  {
    path: "/config",
    label: "admin.nav.config",
    roles: ["admin"],
    element: <ConfigList />,
  },
];

export function App() {
  const { t, locale } = useT();
  const session = useStaffSession();
  const screens =
    session.status === "signed-in"
      ? SCREENS.filter((screen) => screen.roles.includes(session.session.role))
      : [];
  // The front page, until #303 has one of its own: the first screen the role opens.
  const [front] = screens;
  return (
    <>
      <a className="skip target" href="#main">
        {t("admin.skip")}
      </a>
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
      {front && (
        <nav aria-label={t("admin.nav.label")}>
          <ul className="menu">
            {screens.map((screen) => (
              <li key={screen.path}>
                <NavLink to={screen.path}>{t(screen.label)}</NavLink>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <main id="main" tabIndex={-1}>
        {session.status === "loading" && <p aria-busy="true">{t("admin.queue.loading")}</p>}
        {session.status === "signed-out" && <SignIn />}
        {session.status === "signed-in" &&
          (front ? (
            <Screens screens={screens} front={front.path} />
          ) : (
            <p>{t("admin.forbidden")}</p>
          ))}
      </main>
      <SourceOffer />
    </>
  );
}

/** The routes a signed-in role opens, the front page as the first of them, and the one notice of a refusal. */
function Screens({ screens, front }: { screens: readonly Screen[]; front: string }) {
  const { t } = useT();
  const { key } = useLocation();
  // The visit a 403 was answered on: the notice belongs to it, so it is gone
  // once the person moves on and does not come back with them, and a request
  // honoured again takes it back. Several refusals on one visit say it once.
  const visit = useRef(key);
  useEffect(() => {
    visit.current = key;
  }, [key]);
  const [refusedOn, setRefusedOn] = useState<string | null>(null);
  useEffect(() => {
    setRoleAnswerHandler((allowed) => setRefusedOn(allowed ? null : visit.current));
    return () => setRoleAnswerHandler(() => undefined);
  }, []);
  return (
    <NavigationFocus>
      {refusedOn === key && <p role="alert">{t("admin.refused")}</p>}
      <Routes>
        <Route path="/" element={<Navigate to={front} replace />} />
        {SCREENS.map((screen) => (
          <Route
            key={screen.path}
            path={screen.path}
            element={
              screens.includes(screen) ? screen.element : <NotForRole label={screen.label} />
            }
          />
        ))}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </NavigationFocus>
  );
}

/** A screen the role does not open (#304): said where it is asked for, and nothing is fetched. */
function NotForRole({ label }: { label: PlainMessageKey }) {
  const { t } = useT();
  return (
    <section aria-labelledby="not-for-role-title">
      <ScreenTitle id="not-for-role-title">{t(label)}</ScreenTitle>
      <p>{t("admin.refused")}</p>
    </section>
  );
}

function NotFound() {
  const { t } = useT();
  return (
    <section aria-labelledby="not-found-title">
      <ScreenTitle id="not-found-title">{t("admin.notFound.title")}</ScreenTitle>
      <p>
        <Link className="target" to="/">
          {t("admin.notFound.home")}
        </Link>
      </p>
    </section>
  );
}
