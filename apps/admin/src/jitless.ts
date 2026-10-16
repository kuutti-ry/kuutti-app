import { z } from "zod";

// The host's CSP has no 'unsafe-eval' (ADR-025 §3). zod probes for
// `new Function` when the first object schema is built, and the browser
// reports the probe as a violation even though zod catches the throw; jitless
// skips the probe and the compiled parsers with it. The setting has to come
// before @kuutti/schema builds its schemas, which happens when that module is
// evaluated, so it lives in a module of its own that main.tsx imports first:
// a call in main.tsx's own body would run after every module it imports.
z.config({ jitless: true });
