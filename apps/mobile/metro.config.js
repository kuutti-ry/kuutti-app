// Sentry's Metro plugin adds debug ids to bundles and source maps so uploaded
// maps match the JavaScript that ran (#11). It wraps Expo's default config;
// NativeWind (#12) wraps that to compile global.css with Tailwind.
const { createReadStream, existsSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { getSentryExpoConfig } = require("@sentry/react-native/metro");
const { withNativeWind } = require("nativewind/metro");
const saiga = require("../../scripts/saiga.json");

const config = withNativeWind(getSentryExpoConfig(__dirname), { input: "./global.css" });

// The generated native projects are never Metro's: a prebuild with Saiga copies
// its faces into android/app/src/main/res/font, and Metro's /assets/ would hand
// any file it knows to whoever reaches port 8081 on the network (ADR-052).
// Anchored here, so the android/ and ios/ folders of packages stay visible.
const escaped = __dirname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
config.resolver.blockList = [
  ...[].concat(config.resolver.blockList ?? []),
  new RegExp(`^${escaped}[\\\\/](?:android|ios)[\\\\/]`),
];

// Saiga for the web target (ADR-052): global.css names /fonts/saiga-<version>/,
// and the dev server answers it from ~/.cache/kuutti-fonts, where `pnpm fonts`
// put it, to this computer alone: Metro also listens to the network, for a
// phone, and the files are for nobody else. Without them it answers 404 and
// the web target is in the system font. They are never in the project, so
// Metro cannot bundle them and no export carries them.
// shortcut: enhanceMiddleware is deprecated in Expo CLI; a dev-server hook of
// its own, when there is one.
const FONTS = `/fonts/saiga-${saiga.version}/`;
const WOFF2 = new Set(saiga.faces.map(({ name }) => `${name}.woff2`));
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
// A tunnel or a port forwarder also arrives on loopback: it names another host or says it forwards.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FORWARDED = ["forwarded", "x-forwarded-for", "x-forwarded-host"];
function fromThisComputer(req) {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  return (
    LOOPBACK.has(req.socket.remoteAddress) &&
    LOCAL_HOSTS.has(host) &&
    FORWARDED.every((name) => req.headers[name] === undefined)
  );
}
const enhance = config.server.enhanceMiddleware;
config.server.enhanceMiddleware = (metroMiddleware, server) => {
  const middleware = enhance ? enhance(metroMiddleware, server) : metroMiddleware;
  return (req, res, next) => {
    const path = (req.url ?? "").split("?")[0];
    if (!path.startsWith(FONTS)) return middleware(req, res, next);
    const file = path.slice(FONTS.length);
    const local = join(
      homedir(),
      ".cache",
      "kuutti-fonts",
      `saiga-${saiga.version}`,
      "WOFF2",
      file,
    );
    if (!WOFF2.has(file) || !fromThisComputer(req) || !existsSync(local)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("Content-Type", "font/woff2");
    createReadStream(local).pipe(res);
  };
};

module.exports = config;
