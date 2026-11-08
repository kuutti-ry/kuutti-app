// The logo files from Gaiane's two drawings of the seal pup's face
// (docs/design/logo, 2000 px JPEGs): the outline, ink on paper, and the
// filled face, light on her ink. Run from apps/mobile:
//
//   node scripts/logo/icons.mjs [--preview <file.png>]
//
// It writes the app's icons, splash images and mark into assets/, and the
// mark and the favicon into the admin panel's src/. The icons are her dark
// version: the filled face, white, on her ink #232323, which is also the
// adaptive icon's background colour in app.json (the maintainer's choice of
// 24/10/2026). The mark is the outline in her ink on transparency; the app
// tints it with the foreground token, and the panel inverts it on a dark page.
// The splash is the outline on the light theme and the filled face on the
// dark one, over the themes' own backgrounds (app.json's expo-splash-screen).
//
// The icons and the splash images move the native fingerprint (rules/mobile.md),
// except the monochrome icon, whose content the fingerprint does not hash: a
// change to that file alone needs a new name or an entry in extraSources.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { canvas, composite, decode, encode } from "./png.mjs";

const HERE = import.meta.dirname;
const DRAWINGS = join(HERE, "../../../../docs/design/logo");
const ASSETS = join(HERE, "../../assets");
const ADMIN = join(HERE, "../../../admin/src");
const INK = [0x23, 0x23, 0x23];
const WHITE = [255, 255, 255];
const NONE = [0, 0, 0, 0];
const BACKGROUND = [...INK, 255];
// The drawings' ink and paper, measured: 35 and 252 in every channel.
const DARKEST = 35;
const LIGHTEST = 252;
// The light drawing carries a thin grey frame at its edges.
const FRAME = 8;
// Source pixels kept around the face, so the antialiasing of its outermost
// strokes survives the crop.
const PAD = 8;

const flag = process.argv.indexOf("--preview");
const previewPath = flag === -1 ? undefined : process.argv[flag + 1];
if (flag !== -1 && (!previewPath || previewPath.startsWith("--"))) {
  throw new Error("--preview needs the file to write");
}

const work = mkdtempSync(join(tmpdir(), "kuutti-logo-"));
// sips says what went wrong on stderr and goes on, so its stderr is shown.
const sips = (args) => execFileSync("sips", args, { stdio: ["ignore", "ignore", "inherit"] });

/**
 * The drawing as a mask, alpha = how much ink (or, for the dark one, face),
 * cropped to the face with PAD around it; `face` is the face's own width.
 */
function maskOf(file, { light }) {
  const source = join(DRAWINGS, file);
  if (!existsSync(source)) throw new Error(`no drawing ${source}`);
  const png = join(work, `${basename(file)}.png`);
  sips(["-s", "format", "png", source, "--out", png]);
  const img = decode(readFileSync(png));
  const alpha = new Uint8Array(img.w * img.h);
  let [x0, y0, x1, y1] = [img.w, img.h, -1, -1];
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const o = (y * img.w + x) * 4;
      const v = (img.px[o] + img.px[o + 1] + img.px[o + 2]) / 3;
      const t = Math.min(1, Math.max(0, (v - DARKEST) / (LIGHTEST - DARKEST)));
      const a = Math.round(255 * (light ? t : 1 - t));
      alpha[y * img.w + x] = a;
      const inside = x >= FRAME && y >= FRAME && x < img.w - FRAME && y < img.h - FRAME;
      if (inside && a > 127)
        [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
  if (x1 < 0) throw new Error(`no face found in ${file}`);
  const w = x1 - x0 + 1 + 2 * PAD;
  const h = y1 - y0 + 1 + 2 * PAD;
  const mask = { ...canvas(w, h, [...WHITE, 0]), face: x1 - x0 + 1 };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = x + x0 - PAD;
      const sy = y + y0 - PAD;
      const inside = sx >= FRAME && sy >= FRAME && sx < img.w - FRAME && sy < img.h - FRAME;
      if (inside) mask.px[(y * w + x) * 4 + 3] = alpha[sy * img.w + sx];
    }
  return mask;
}

/** The mask with its face `faceWidth` px wide, through sips, which resamples better than anything here. */
function scaled(mask, faceWidth) {
  // An even width centres on an even canvas without a half pixel.
  const width = 2 * Math.round((faceWidth * mask.w) / mask.face / 2);
  const from = join(work, "mask.png");
  const to = join(work, `mask-${width}.png`);
  writeFileSync(from, encode(mask));
  sips(["--resampleWidth", String(width), from, "--out", to]);
  return decode(readFileSync(to));
}

/** The face at `scale` of a `size` square's width, its middle at `middle` of the height. */
function drawn(mask, size, scale, middle, background, ink, { alpha }) {
  const mark = scaled(mask, size * scale);
  const c = canvas(size, size, background);
  composite(c, mark, (size - mark.w) / 2, Math.round(size * middle - mark.h / 2), ink);
  return encode(c, { alpha });
}

/** The face alone, `faceWidth` px wide, on transparency: the splash's image. */
function alone(mask, faceWidth, ink) {
  const mark = scaled(mask, faceWidth);
  const c = canvas(mark.w, mark.h, NONE);
  composite(c, mark, 0, 0, ink);
  return encode(c);
}

try {
  const outline = maskOf("seal-face-light-2000.jpg", { light: false });
  const face = maskOf("seal-face-dark-2000.jpg", { light: true });
  const write = (dir, name, png) => writeFileSync(join(dir, name), png);

  // iOS: no alpha, Apple's squircle clips the corners. The face as Gaiane placed
  // it on her dark square: 82.5 % of the width, its middle at 47 % of the height.
  write(ASSETS, "icon.png", drawn(face, 1024, 0.825, 0.47, BACKGROUND, WHITE, { alpha: false }));
  // Android adaptive, 108 dp: the launcher shows about the central 72, and the
  // 66 dp circle in the middle is safe from every mask. At 56 % the whole face,
  // the wave's two ends included, sits inside that circle with under 1 dp to spare.
  const foreground = drawn(face, 512, 0.56, 0.48, NONE, WHITE, { alpha: true });
  write(ASSETS, "android-icon-foreground.png", foreground);
  write(ASSETS, "android-icon-background.png", encode(canvas(512, 512, BACKGROUND)));
  // Themed icons (Android 13+) take the alpha alone: the eyes, the nose and the
  // whiskers are holes in the face, so they show in the launcher's colour.
  write(
    ASSETS,
    "android-icon-monochrome.png",
    drawn(face, 432, 0.56, 0.48, NONE, WHITE, { alpha: true }),
  );
  // The favicon of the app's web target and of the panel: the iOS icon, drawn
  // small rather than shrunk, which would ring at the edges.
  const favicon = drawn(face, 48, 0.825, 0.47, BACKGROUND, WHITE, { alpha: false });
  write(ASSETS, "favicon.png", favicon);
  write(ADMIN, "favicon.png", favicon);
  // The mark beside the name, in the app and in the panel: the face 384 px wide
  // in a 392 px square.
  const mark = drawn(outline, 392, 384 / 392, 0.5, NONE, INK, { alpha: true });
  write(ASSETS, "logo-mark.png", mark);
  write(ADMIN, "logo-mark.png", mark);
  // The splash: the face alone, 1024 px wide. app.json shows it 176 dp wide:
  // Android 12 and later show the splash image only inside a 192 dp circle,
  // and at 176 the wave's ends stay 1 dp inside it.
  write(ASSETS, "splash-icon.png", alone(outline, 1024, INK));
  write(ASSETS, "splash-icon-dark.png", alone(face, 1024, WHITE));

  // --preview <file>: the Android result as a round launcher shows it, to judge here.
  if (previewPath) {
    const preview = canvas(512, 512, [255, 255, 255, 255]);
    const icon = canvas(512, 512, BACKGROUND);
    composite(icon, decode(foreground), 0, 0);
    const r = 512 / 3;
    for (let y = 0; y < 512; y++)
      for (let x = 0; x < 512; x++) {
        const o = (y * 512 + x) * 4;
        if ((x - 256) ** 2 + (y - 256) ** 2 <= r * r) preview.px.set(icon.px.subarray(o, o + 4), o);
      }
    writeFileSync(previewPath, encode(preview, { alpha: false }));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(
  "written: the icons, the splash images and the mark in assets/; the mark and the favicon in the panel's src/",
);
