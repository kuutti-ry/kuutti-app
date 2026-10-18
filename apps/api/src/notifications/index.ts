// The notifications slice's public surface in apps/api (#176, ADR-032). Other slices import from here only.

// The choices and the notices: the routes, a warning's notice for the safety
// slice, and the halves erasure and the export call (ADR-007 §4).
export {
  eraseNotificationsOf,
  exportNotifications,
  recordWarningNotice,
} from "./notifications.ts";
export { notificationRoutes } from "./routes.ts";
