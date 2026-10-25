// Public surface of the notifications slice in apps/mobile (#176). Other slices import from here only.

export { Notices } from "./Notices";
// What a person may be notified of, for Settings; the notices, for the home screen.
export { NotificationChoices } from "./NotificationChoices";
// The push on this phone, for the root layout; its one offer, for the home screen (#102).
export { PushNotifications } from "./PushNotifications";
export { PushOffer } from "./PushOffer";
