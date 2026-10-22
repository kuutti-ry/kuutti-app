// The notifications slice's public surface in apps/api (#176, ADR-032). Other slices import from here only.

// The choices and the notices: the routes, a warning's notice for the safety
// slice, a counted invitation's for the rewards slice (#107), and the halves
// erasure and the export call (ADR-007 §4).
export {
  eraseNotificationsOf,
  exportNotifications,
  recordInvitationNotices,
  recordWarningNotice,
} from "./notifications.ts";
export { notificationRoutes } from "./routes.ts";
