import { formatTime, type PlainMessageKey } from "@kuutti/i18n";
import { useT } from "@kuutti/i18n/react";
import type { ModeratorRole } from "@kuutti/schema";
import {
  Flag,
  Image,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  MessageSquare,
  ScrollText,
  ShieldAlert,
  SlidersHorizontal,
  UserSearch,
  UsersRound,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router";
import { Alert } from "./components/ui/alert.tsx";
import { Button } from "./components/ui/button.tsx";
import { Loading } from "./components/ui/spinner.tsx";
import { SignIn, useStaffSession } from "./features/identity/index.ts";
import { PhotoQueue } from "./features/media/index.ts";
import {
  AccountLookup,
  AccountPage,
  AuditLog,
  AutomaticBans,
  ConfigList,
  FeedbackList,
  Overview,
  ReportPage,
  ReportQueue,
  StaffList,
} from "./features/safety/index.ts";
import { setRoleAnswerHandler } from "./lib/api.ts";
import { StaffRole } from "./lib/role.ts";
import { NavigationFocus, ScreenTitle } from "./lib/screen-title.tsx";
import { cn } from "./lib/utils.ts";
import mark from "./logo-mark.png";
import { SourceOffer } from "./source-offer.tsx";

// The moderation panel (#49, #302, rules/admin.md): a staff bank login, then
// one screen per path with a menu of what the role opens. English only by
// decision (TD-17); react-router's declarative routes, and shadcn/ui's
// components on Tailwind (ADR-047, the component decision of rules/admin.md):
// a header, the menu beside the screen on a wide window and above it on a
// narrow one, the footer under the screen.

type Screen = {
  path: string;
  label: PlainMessageKey;
  /** The menu's icon, decorative: the label says the screen. */
  icon: LucideIcon;
  /** The roles the menu shows it to; the API's own guard is what refuses the rest. */
  roles: readonly ModeratorRole[];
  element: ReactNode;
  /** False for a screen reached from another, not from the menu (a person's page, #306; a report, #312). */
  inMenu?: false;
};

const SCREENS: readonly Screen[] = [
  {
    path: "/",
    label: "admin.nav.overview",
    icon: LayoutDashboard,
    roles: ["moderator", "admin"],
    element: <Overview />,
  },
  {
    path: "/reports",
    label: "admin.nav.reports",
    icon: Flag,
    roles: ["moderator", "admin"],
    element: <ReportQueue />,
  },
  {
    path: "/reports/:id",
    label: "admin.nav.reports",
    icon: Flag,
    roles: ["moderator", "admin"],
    element: <ReportPage />,
    inMenu: false,
  },
  {
    path: "/automatic-bans",
    label: "admin.nav.automaticBans",
    icon: ShieldAlert,
    roles: ["moderator", "admin"],
    element: <AutomaticBans />,
  },
  {
    path: "/photos",
    label: "admin.nav.photos",
    icon: Image,
    roles: ["moderator", "admin"],
    element: <PhotoQueue />,
  },
  {
    path: "/feedback",
    label: "admin.nav.feedback",
    icon: MessageSquare,
    roles: ["moderator", "admin"],
    element: <FeedbackList />,
  },
  {
    path: "/accounts",
    label: "admin.nav.accounts",
    icon: UserSearch,
    roles: ["moderator", "admin"],
    element: <AccountLookup />,
  },
  {
    path: "/accounts/:id",
    label: "admin.nav.accounts",
    icon: UserSearch,
    roles: ["moderator", "admin"],
    element: <AccountPage />,
    inMenu: false,
  },
  {
    path: "/config",
    label: "admin.nav.config",
    icon: SlidersHorizontal,
    roles: ["admin"],
    element: <ConfigList />,
  },
  {
    path: "/audit",
    label: "admin.nav.audit",
    icon: ScrollText,
    roles: ["admin"],
    element: <AuditLog />,
  },
  {
    path: "/staff",
    label: "admin.nav.staff",
    icon: UsersRound,
    roles: ["admin"],
    element: <StaffList />,
  },
];

export function App() {
  const { t, locale } = useT();
  const session = useStaffSession();
  const screens =
    session.status === "signed-in"
      ? SCREENS.filter((screen) => screen.roles.includes(session.session.role))
      : [];
  // A role with no screen (a researcher, until #194) gets the forbidden text and no menu.
  const [front] = screens;
  return (
    <div className="flex min-h-dvh flex-col">
      {/* Out of sight above the page until a keyboard reaches it (#302). */}
      <a
        className="fixed start-4 top-4 z-50 min-h-11 -translate-y-[200%] rounded-md bg-card px-4 py-2.5 font-medium shadow-lg ring-1 ring-foreground/10 focus:translate-y-0"
        href="#main"
      >
        {t("admin.skip")}
      </a>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-card px-4 py-3 md:px-6">
        {/* The mark is decorative: the heading right beside it carries the name. Drawn dark, it turns light on a dark page. */}
        <img src={mark} alt="" width={40} height={40} className="size-10 dark:invert" />
        <h1 className="flex-1 text-lg font-semibold tracking-tight">{t("admin.title")}</h1>
        {session.status === "signed-in" && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-sm text-muted-foreground">
              {t("admin.session.role", { role: session.session.role })} ·{" "}
              {t("admin.session.expires", {
                time: formatTime(locale, new Date(session.session.expiresAt)),
              })}
            </p>
            <Button variant="outline" onClick={() => void session.signOut()}>
              <LogOut aria-hidden="true" />
              {t("admin.signOut")}
            </Button>
          </div>
        )}
      </header>
      <div
        className={cn(
          "flex flex-1 flex-col",
          front && "md:grid md:grid-cols-[15rem_minmax(0,1fr)]",
        )}
      >
        {front && <Menu screens={screens} />}
        <div className="flex min-w-0 flex-1 flex-col">
          <main
            id="main"
            tabIndex={-1}
            className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-6 md:px-8 md:py-8"
          >
            {session.status === "loading" && <Loading>{t("admin.queue.loading")}</Loading>}
            {session.status === "signed-out" && <SignIn />}
            {session.status === "signed-in" &&
              (front ? (
                // The role reaches the screens, for an action only some roles see (#308).
                <StaffRole.Provider value={session.session.role}>
                  <Screens screens={screens} />
                </StaffRole.Provider>
              ) : (
                <p className="text-muted-foreground">{t("admin.forbidden")}</p>
              ))}
          </main>
          <SourceOffer />
        </div>
      </div>
    </div>
  );
}

/**
 * The menu of what the role opens (#302): a row that scrolls on a narrow
 * screen, a column beside the screen on a wide one. The current screen is
 * said by weight and a bar, never by colour alone.
 */
function Menu({ screens }: { screens: readonly Screen[] }) {
  const { t } = useT();
  const { pathname } = useLocation();
  const row = useRef<HTMLUListElement>(null);
  const items = screens.filter((screen) => screen.inMenu !== false);
  // The menu's links as one value: a role confirmed by the API may bring more (#302).
  const paths = items.map((screen) => screen.path).join(" ");
  // On a narrow screen the current screen's link is scrolled into the row, again with each
  // path and each change of the links; the page itself never moves.
  useEffect(() => {
    const list = row.current;
    const current = list?.querySelector('[aria-current="page"]');
    if (!list || !current || list.scrollWidth <= list.clientWidth) return;
    list.scrollLeft +=
      current.getBoundingClientRect().left - list.getBoundingClientRect().left - 16;
  }, [pathname, paths]);
  return (
    <nav aria-label={t("admin.nav.label")} className="border-b bg-card md:border-e md:border-b-0">
      <ul
        ref={row}
        className="flex gap-1 overflow-x-auto px-4 py-2 md:sticky md:top-0 md:flex-col md:overflow-visible md:p-3"
      >
        {items.map((screen) => (
          <li key={screen.path} className="shrink-0">
            {/* `end`: the front page is the current one only at "/" itself. */}
            <NavLink
              to={screen.path}
              end
              className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground no-underline hover:bg-accent hover:text-accent-foreground aria-[current=page]:bg-accent aria-[current=page]:font-semibold aria-[current=page]:text-accent-foreground aria-[current=page]:shadow-[inset_0_-3px_0_var(--primary)] md:aria-[current=page]:shadow-[inset_3px_0_0_var(--primary)] forced-colors:aria-[current=page]:underline"
            >
              <screen.icon aria-hidden="true" className="size-4 shrink-0" />
              {t(screen.label)}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The routes a signed-in role opens, the front page (#303) among them, and the one notice of a refusal. */
function Screens({ screens }: { screens: readonly Screen[] }) {
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
      {refusedOn === key && <Alert>{t("admin.refused")}</Alert>}
      <Routes>
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
    <section aria-labelledby="not-for-role-title" className="space-y-6">
      <ScreenTitle id="not-for-role-title">{t(label)}</ScreenTitle>
      <p className="text-muted-foreground">{t("admin.refused")}</p>
    </section>
  );
}

function NotFound() {
  const { t } = useT();
  return (
    <section aria-labelledby="not-found-title" className="space-y-6">
      <ScreenTitle id="not-found-title">{t("admin.notFound.title")}</ScreenTitle>
      <p>
        <Link className="target" to="/">
          {t("admin.notFound.home")}
        </Link>
      </p>
    </section>
  );
}
