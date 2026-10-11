import type { GetParametersByPathCommand } from "@aws-sdk/client-ssm";
import { describe, expect, it } from "vitest";
import { DEFAULT_REGION, loadSsmParameters, parameterNameToEnvKey, ssmRegion } from "./ssm.ts";

describe("ssmRegion", () => {
  it("takes AWS_REGION, then AWS_DEFAULT_REGION, then the project region", () => {
    expect(ssmRegion({ AWS_REGION: "eu-north-1" })).toBe("eu-north-1");
    expect(ssmRegion({ AWS_DEFAULT_REGION: "eu-west-1" })).toBe("eu-west-1");
    expect(ssmRegion({})).toBe(DEFAULT_REGION);
    expect(DEFAULT_REGION).toBe("eu-central-1");
  });
});

describe("parameterNameToEnvKey", () => {
  it("maps a parameter path under the prefix to an upper snake key", () => {
    expect(parameterNameToEnvKey("/kuutti/staging/db-app-password", "/kuutti/staging/")).toBe(
      "DB_APP_PASSWORD",
    );
    expect(parameterNameToEnvKey("/kuutti/staging/nested/log-level", "/kuutti/staging/")).toBe(
      "NESTED_LOG_LEVEL",
    );
  });
});

describe("loadSsmParameters", () => {
  it("follows pagination and decrypts", async () => {
    const calls: GetParametersByPathCommand[] = [];
    const client = {
      send: async (command: GetParametersByPathCommand) => {
        calls.push(command);
        return calls.length === 1
          ? {
              Parameters: [{ Name: "/kuutti/staging/db-host", Value: "rds.internal" }],
              NextToken: "t2",
            }
          : { Parameters: [{ Name: "/kuutti/staging/db-name", Value: "kuutti" }] };
      },
    };
    const values = await loadSsmParameters("/kuutti/staging/", client);
    expect(values).toEqual({ DB_HOST: "rds.internal", DB_NAME: "kuutti" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.input).toMatchObject({
      Path: "/kuutti/staging/",
      Recursive: true,
      WithDecryption: true,
    });
    expect(calls[1]?.input.NextToken).toBe("t2");
  });
});

describe("parameters that do not fit", () => {
  it("keys a parameter outside the prefix by its whole path", () => {
    expect(parameterNameToEnvKey("/kuutti/shared/sentry-dsn", "/kuutti/staging/")).toBe(
      "KUUTTI_SHARED_SENTRY_DSN",
    );
  });

  it("skips a parameter without a name or a value, and a page without parameters", async () => {
    const pages = [
      {
        Parameters: [
          { Name: "/kuutti/staging/db-host", Value: "rds.internal" },
          { Value: "a value with no name" },
          { Name: "/kuutti/staging/db-name" },
          // An empty string is a value: SSM stores none, but nothing here decides that.
          { Name: "/kuutti/staging/log-level", Value: "" },
        ],
        NextToken: "t2",
      },
      { NextToken: "t3" },
      {},
    ];
    let page = 0;
    const client = { send: async () => pages[page++] ?? {} };
    expect(await loadSsmParameters("/kuutti/staging/", client)).toEqual({
      DB_HOST: "rds.internal",
      LOG_LEVEL: "",
    });
    expect(page).toBe(3);
  });
});
