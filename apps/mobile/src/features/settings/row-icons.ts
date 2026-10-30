import type { LucideIcon } from "lucide-react-native";
import Bell from "lucide-react-native/icons/bell";
import Captions from "lucide-react-native/icons/captions";
import CodeXml from "lucide-react-native/icons/code-xml";
import Contact from "lucide-react-native/icons/contact";
import Download from "lucide-react-native/icons/download";
import FileLock from "lucide-react-native/icons/file-lock";
import FlaskConical from "lucide-react-native/icons/flask-conical";
import Hand from "lucide-react-native/icons/hand";
import HeartHandshake from "lucide-react-native/icons/heart-handshake";
import Info from "lucide-react-native/icons/info";
import Languages from "lucide-react-native/icons/languages";
import Lock from "lucide-react-native/icons/lock";
import LogOut from "lucide-react-native/icons/log-out";
import Mail from "lucide-react-native/icons/mail";
import MessageSquareText from "lucide-react-native/icons/message-square-text";
import Scale from "lucide-react-native/icons/scale";
import ScrollText from "lucide-react-native/icons/scroll-text";
import Shield from "lucide-react-native/icons/shield";
import SunMoon from "lucide-react-native/icons/sun-moon";
import Ticket from "lucide-react-native/icons/ticket";
import UserRound from "lucide-react-native/icons/user-round";

/**
 * The picture before each row of Settings, by the row's key (#511): Lucide's,
 * placeholders until the designer's icons come (#410), which replace this
 * one file. Decoration only: the row's title names it.
 */
export const ROW_ICONS: Record<string, LucideIcon> = {
  language: Languages,
  theme: SunMoon,
  photoDescriptions: Captions,
  decisionButtons: Hand,
  notifications: Bell,
  email: Mail,
  contacts: Contact,
  lock: Lock,
  research: FlaskConical,
  special_category: Shield,
  export: Download,
  support: HeartHandshake,
  invitations: Ticket,
  feedback: MessageSquareText,
  version: Info,
  terms: ScrollText,
  privacy: FileLock,
  source: CodeXml,
  licenses: Scale,
  device: LogOut,
  account: UserRound,
};
