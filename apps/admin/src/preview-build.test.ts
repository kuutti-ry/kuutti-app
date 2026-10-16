// @vitest-environment node
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The panel as a preview ships it (ADR-025 §3, §6): a production build with
// Vite's base /pr-7/, against the staging API. The host's CSP allows scripts
// and styles from the host alone and images from the host and the API, so the
// page carries no inline script or style, nothing is inlined as a data: URL,
// and every file the page names sits under the preview's own prefix, where
// the CloudFront Function leaves it alone.

const app = fileURLToPath(new URL("..", import.meta.url));
let outDir = "";
let html = "";
/** The emitted scripts and stylesheets, by file name under assets/. */
let emitted: Map<string, string>;

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "kuutti-admin-preview-"));
  // Vitest runs with NODE_ENV=test, which would give a development React.
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VITE_API_URL", "https://api.staging.kuutti.app");
  try {
    await build({
      root: app,
      base: "/pr-7/",
      mode: "production",
      logLevel: "silent",
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    vi.unstubAllEnvs();
  }
  html = readFileSync(join(outDir, "index.html"), "utf8");
  emitted = new Map(
    readdirSync(join(outDir, "assets"))
      .filter((name) => /\.(js|css)$/.test(name))
      .map((name) => [name, readFileSync(join(outDir, "assets", name), "utf8")]),
  );
}, 60_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe("a preview's build", () => {
  it("has no inline script, style or event handler on its page", () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attributes, body = ""] of scripts) {
      expect(attributes).toMatch(/\ssrc="[^"]+"/);
      expect(body.trim()).toBe("");
    }
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it("names every file of its page under the preview's assets, and each is there", () => {
    const references = [...html.matchAll(/\s(?:src|href)="([^"]*)"/g)].map(([, url = ""]) => url);
    expect(references).toEqual(
      expect.arrayContaining([expect.stringMatching(/\.js$/), expect.stringMatching(/\.css$/)]),
    );
    for (const url of references) {
      expect(url).toMatch(/^\/pr-7\/assets\/[^/]+$/);
      expect(existsSync(join(outDir, url.replace(/^\/pr-7\//, "")))).toBe(true);
    }
  });

  it("inlines nothing as a data: URL, and its scripts name the logo under the preview", () => {
    const code = [...emitted.values()].join("\n");
    expect(code).not.toMatch(/data:[a-z]+\/[\w.+-]+[;,]/i);
    const logo = readdirSync(join(outDir, "assets")).find((name) => name.startsWith("logo-mark-"));
    expect(logo).toMatch(/\.png$/);
    expect(code).toContain(`/pr-7/assets/${logo}`);
    // No path of an asset outside the preview's prefix.
    expect(code).not.toMatch(/(?<!\/pr-7)\/assets\//);
  });
});
