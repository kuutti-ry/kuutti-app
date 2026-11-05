/**
 * @jest-environment node
 */
const { DevToolsPlugin } = require("@expo/cli/build/src/start/server/DevToolsPlugin.js");
const {
  DevToolsPluginCliExtensionResults,
} = require("@expo/cli/build/src/start/server/DevToolsPluginCliExtensionResults.js");
const {
  createMCPDevToolsExtensionSchema,
} = require("@expo/cli/build/src/start/server/createMCPDevToolsExtensionSchema.js");

// pnpm-workspace.yaml overrides the zod 3 under @expo/cli across a major, to 4.6.7
// (GHSA-mrhx-c7xc-m3w5, #586). The dev server builds these schemas as it starts,
// and uses them on a DevTools plugin and on what the plugin's commands print; the
// project has no such plugin, so nothing else would notice them break. Goes with
// the override. That the override stays is the audit's to hold: it no longer sets
// the advisory aside.
const plugin = {
  packageName: "some-plugin",
  packageRoot: "/project/node_modules/some-plugin",
  cliExtensions: {
    description: "Does something",
    entryPoint: "cli.js",
    commands: [
      {
        name: "run",
        title: "Run it",
        environments: ["cli", "mcp"],
        parameters: [{ name: "times", type: "number", description: "How many" }],
      },
    ],
  },
};

const command = plugin.cliExtensions.commands[0];

function withCommand(change) {
  return {
    ...plugin,
    cliExtensions: { ...plugin.cliExtensions, commands: [{ ...command, ...change }] },
  };
}

describe("a DevTools plugin, read through the zod the override gives the CLI", () => {
  it.each([
    ["with commands", plugin],
    [
      "with no commands at all",
      { packageName: plugin.packageName, packageRoot: plugin.packageRoot },
    ],
    ["with a banner that is on", { ...plugin, bannerTitle: true }],
    ["with a banner that has a title", { ...plugin, bannerTitle: "Some plugin" }],
    ["with a command that takes no parameters", withCommand({ parameters: undefined })],
  ])("is taken %s", (_, config) => {
    expect(new DevToolsPlugin(config, "/project").packageName).toBe("some-plugin");
  });

  it.each([
    ["an empty name", { ...plugin, packageName: "" }, "packageName"],
    ["no root", { ...plugin, packageRoot: undefined }, "packageRoot"],
    ["an empty banner", { ...plugin, bannerTitle: "" }, "bannerTitle"],
    ["a banner that is a number", { ...plugin, bannerTitle: 1 }, "bannerTitle"],
    [
      "an empty list of commands",
      { ...plugin, cliExtensions: { ...plugin.cliExtensions, commands: [] } },
      "commands",
    ],
    ["a command with an empty title", withCommand({ title: "" }), "title"],
    [
      "a command for an unknown environment",
      withCommand({ environments: ["web"] }),
      "environments",
    ],
    [
      "a parameter of an unknown type",
      withCommand({ parameters: [{ name: "times", type: "date" }] }),
      "type",
    ],
  ])("is refused with %s, and the refusal names what is wrong", (_, config, field) => {
    expect(() => new DevToolsPlugin(config, "/project")).toThrow(
      new RegExp(`^Invalid plugin configuration: [^]*"${field}"`),
    );
  });
});

describe("what a plugin's command prints, read through the same zod", () => {
  function read(printed) {
    const results = new DevToolsPluginCliExtensionResults();
    results.append(JSON.stringify(printed));
    return results.getOutput();
  }

  it("comes back as its lines", () => {
    const lines = [
      { type: "text", text: "Done", level: "info" },
      { type: "text", text: "See this", url: "not checked here", level: "warning" },
      { type: "image", url: "https://example.org/a.png", text: "A picture" },
      { type: "audio", url: "https://example.org/a.mp3" },
    ];

    expect(read(lines)).toEqual(lines);
  });

  it.each([
    ["an image whose address is not one", [{ type: "image", url: "not an address" }]],
    ["sound with no address", [{ type: "audio" }]],
    ["text at an unknown level", [{ type: "text", text: "Done", level: "debug" }]],
    ["a line of an unknown kind", [{ type: "video", url: "https://example.org/a.mp4" }]],
    ["something other than a list", { type: "text", text: "Done", level: "info" }],
  ])("is answered as invalid when it is %s", (_, printed) => {
    expect(read(printed)).toEqual([
      { type: "text", text: expect.stringMatching(/^Invalid JSON: ./), level: "error" },
    ]);
  });
});

describe("the input an MCP client may send a plugin, held by the same zod", () => {
  const schema = createMCPDevToolsExtensionSchema(plugin);

  it.each([
    ["a command and its parameter", { command: "run", times: 3 }],
    ["a command with its parameter left out", { command: "run" }],
  ])("takes %s", (_, input) => {
    expect(schema.safeParse(input)).toEqual({ success: true, data: input });
  });

  it.each([
    ["a command the plugin does not have", { command: "stop" }],
    ["no command", { times: 3 }],
    ["a parameter of the wrong type", { command: "run", times: "3" }],
    ["a parameter the plugin does not have", { command: "run", other: 1 }],
  ])("refuses %s", (_, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});
