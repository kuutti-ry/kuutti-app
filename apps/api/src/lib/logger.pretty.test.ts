import { describe, expect, it, vi } from "vitest";

// Development's logger (NODE_ENV=development, index.ts): its lines go through
// pino-pretty, which is a dev dependency outside the production bundle. The
// stream is replaced by one this test reads, so what reaches pino-pretty is
// seen: the same redacted line as anywhere else.
const pretty = vi.hoisted(() => ({ options: [] as unknown[], lines: [] as string[] }));
vi.mock("pino-pretty", () => ({
  default: (options: unknown) => {
    pretty.options.push(options);
    return {
      write(line: string) {
        pretty.lines.push(line);
      },
    };
  },
}));

import { createLogger } from "./logger.ts";

describe("the development logger", () => {
  it("writes through pino-pretty, in colour with the time of day, at the configured level and redacted", async () => {
    const logger = await createLogger({ level: "debug", pretty: true });
    expect(pretty.options).toEqual([{ colorize: true, translateTime: "HH:MM:ss" }]);
    expect(logger.level).toBe("debug");

    logger.trace("below the level");
    logger.debug({ hetu: "010190-123A", email: "a@b.fi", accountId: "acc-1" }, "probe");
    expect(pretty.lines).toHaveLength(1);
    const line = JSON.parse(pretty.lines[0] ?? "{}") as Record<string, unknown>;
    expect(line).toMatchObject({ msg: "probe", accountId: "acc-1", hetu: "[redacted]" });
    expect(pretty.lines[0]).not.toMatch(/010190-123A|a@b\.fi/);
  });
});
