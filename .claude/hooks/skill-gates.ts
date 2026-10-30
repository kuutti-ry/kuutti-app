/**
 * What a session owes the repository's skills (#525), read from its transcript
 * and from GitHub, so it holds however the agent got there. Three hooks run it:
 *
 *   edit (PreToolUse on the edit tools): a file of a product rule or of the
 *     schema is refused until change-rule or personal-data has run in the
 *     session: those two ask what to build, so they come before the edit.
 *   create (PreToolUse on Bash): `gh pr create` is refused until open-pr has
 *     run, and every skill of SKILLS whose paths the branch changes. This also
 *     catches what a shell command wrote, which the edit gate never sees.
 *   stop (Stop): a turn does not end while a pull request the session opened
 *     has no Auto-fix, or one it opened or merged has merged with its issues
 *     unchecked. GitHub says what merged, so a merge on the website counts;
 *     `after-merge.sh` only ever saw `gh pr merge`.
 *
 * Auto-fix is a switch of the desktop app, so nothing asks for it elsewhere.
 * Whatever cannot be read (the hook's input, the transcript, GitHub) lets the
 * session go on: a broken hook must not hold up work, and --self-test in CI's
 * lint job holds the logic. A stop asks once: Claude Code marks the retry with
 * stop_hook_active, and answering it would loop on a duty that cannot be met.
 *
 * Usage: node .claude/hooks/skill-gates.ts edit|create|stop (hook input on stdin)
 *        node .claude/hooks/skill-gates.ts --self-test
 * No dependencies. Needs Node 22.18+ (type stripping).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

// A command, not the words in a grep or a quoted string.
const AT_COMMAND = String.raw`(?:^|[;&|(\n])\s*(?:\w+=\S*\s+)*`;
const CREATE = new RegExp(`${AT_COMMAND}gh\\s+pr\\s+create\\b`);
const MERGE = new RegExp(`${AT_COMMAND}gh\\s+pr\\s+merge\\b([^;&|\\n]*)`, "g");
const CD = /(?:^|&&\s*|;\s*)cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)/;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
const REFS = /^\s*Refs\s+\S*#\d+/im;

// A diff names a file from the repository's root and an edit tool by its whole
// path, so these match from any directory. A test alone changes no rule or screen.
const AT_DIR = "(?:^|/)";
const NOT_A_TEST = String.raw`(?!.*\.test\.tsx?$)`;
const SCHEMA = new RegExp(`${AT_DIR}packages/db/(?:src/schema|drizzle)/`);
const RULES = new RegExp(
  `${AT_DIR}(?:(?:apps/api/src|apps/mobile/src/features|features)/(?:matching|pond|rewards|notifications|research)/${NOT_A_TEST}` +
    `|apps/mobile/src/features/profile/${NOT_A_TEST}|packages/schema/src/research\\.ts$|docs/decisions\\.md$)`,
);
const CODE = new RegExp(
  String.raw`${AT_DIR}(?:apps|packages|services|scripts|\.claude/hooks)/.+\.tsx?$|${AT_DIR}features/`,
);
const SCREENS = new RegExp(
  `${AT_DIR}apps/(?:mobile/(?:app|src/(?:features|components))|admin/src)/${NOT_A_TEST}.+\\.tsx$`,
);

/** What a change to these paths owes, in the order the work meets it. */
const SKILLS = [
  { skill: "personal-data", paths: SCHEMA, beforeTheEdit: true },
  { skill: "change-rule", paths: RULES, beforeTheEdit: true },
  { skill: "write-tests", paths: CODE, beforeTheEdit: false },
  { skill: "check-screen", paths: SCREENS, beforeTheEdit: false },
];

type Block = {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
};
type HookInput = {
  transcript_path?: string;
  cwd?: string;
  tool_input?: { command?: unknown; file_path?: unknown; notebook_path?: unknown };
  stop_hook_active?: boolean;
  agent_id?: string;
};
type Pull = { state: string; body: string };

/** What a transcript shows the session did. */
type Session = {
  /** Skill name to the arguments of every run. */
  skills: Map<string, string>;
  /** URLs of the pull requests `gh pr create` opened. */
  opened: Set<string>;
  /** What each `gh pr merge` named, in the form `gh pr view` takes. */
  merging: Set<string>;
  /** URLs Auto-fix was asked for, granted or not: a refusal is the maintainer's. */
  autoFix: Set<string>;
};

function readSession(transcript: string): Session {
  const session: Session = {
    skills: new Map(),
    opened: new Set(),
    merging: new Set(),
    autoFix: new Set(),
  };
  const ran = (skill: string, args: string) => {
    session.skills.set(skill, `${session.skills.get(skill) ?? ""} ${args}`);
  };
  const creates = new Set<string | undefined>();
  for (const line of transcript.split("\n")) {
    let entry: { type?: string; isSidechain?: boolean; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // api-request-blob lines repeat the conversation; a subagent is not the session.
    if ((entry.type !== "assistant" && entry.type !== "user") || entry.isSidechain) continue;
    const content = entry.message?.content;
    const blocks: Block[] =
      typeof content === "string"
        ? [{ type: "text", text: content }]
        : ((content as Block[]) ?? []);
    for (const block of blocks) {
      if (block.type === "text" && entry.type === "user") {
        // A skill the user typed as a slash command.
        const name = /<command-name>\/?([\w-]+)<\/command-name>/.exec(block.text ?? "")?.[1];
        const args = /<command-args>(.*?)<\/command-args>/s.exec(block.text ?? "")?.[1];
        if (name) ran(name, args ?? "");
      } else if (block.type === "tool_use" && block.name === "Skill") {
        ran(String(block.input?.skill), String(block.input?.args ?? ""));
      } else if (block.type === "tool_use" && block.name === "mcp__ccd_pr__set_monitor") {
        if (block.input?.auto_fix === true) session.autoFix.add(String(block.input.url));
      } else if (block.type === "tool_use" && block.name === "Bash") {
        const command = String(block.input?.command ?? "");
        if (CREATE.test(command)) creates.add(block.id);
        for (const [, rest] of command.matchAll(MERGE)) {
          const target = mergeTarget(rest ?? "");
          if (target) session.merging.add(target);
        }
      } else if (block.type === "tool_result" && creates.has(block.tool_use_id)) {
        const url = PR_URL.exec(JSON.stringify(block.content ?? ""))?.[0];
        if (url && !block.is_error) session.opened.add(url);
      }
    }
  }
  return session;
}

/** The pull request a `gh pr merge` names; none means the branch's, which `opened` holds. */
function mergeTarget(rest: string): string | undefined {
  const url = PR_URL.exec(rest)?.[0];
  if (url) return url;
  const number = /(?:^|\s)#?(\d+)(?=\s|$)/.exec(rest)?.[1];
  const repo = /(?:--repo[ =]|-R\s+)(\S+)/.exec(rest)?.[1];
  return number && repo ? `https://github.com/${repo}/pull/${number}` : number;
}

function named(skills: string[]): string {
  const list = new Intl.ListFormat("en", { type: "conjunction" }).format(skills);
  return `the ${list} skill${skills.length > 1 ? "s" : ""}`;
}

function refusal(session: Session, changedFiles: () => string[]): string | null {
  const changed = changedFiles();
  const owed = SKILLS.filter(({ paths }) => changed.some((file) => paths.test(file)))
    .map(({ skill }) => skill)
    .concat("open-pr")
    .filter((skill) => !session.skills.has(skill));
  if (owed.length === 0) return null;
  return `Run ${named(owed)} first, then open the pull request (CLAUDE.md, Git).`;
}

function editRefusal(session: Session, file: string): string | null {
  const owed = SKILLS.filter(({ paths, beforeTheEdit }) => beforeTheEdit && paths.test(file))
    .map(({ skill }) => skill)
    .filter((skill) => !session.skills.has(skill));
  if (owed.length === 0) return null;
  return `Run ${named(owed)} before editing this file (CLAUDE.md).`;
}

function duties(session: Session, desktop: boolean, view: (pr: string) => Pull | null): string[] {
  const checked = new Set(session.skills.get("recheck-issues")?.match(/\d+/g));
  const owed: string[] = [];
  const seen = new Set<string>();
  for (const pr of [...session.opened, ...session.merging]) {
    const number = /\d+$/.exec(pr)?.[0] ?? pr;
    if (seen.has(number)) continue;
    seen.add(number);
    const wantsAutoFix = desktop && session.opened.has(pr) && !session.autoFix.has(pr);
    const wantsCheck = !checked.has(number);
    if (!wantsAutoFix && !wantsCheck) continue;
    const pull = view(pr);
    if (pull?.state === "OPEN" && wantsAutoFix) {
      owed.push(
        `Pull request ${pr} has no Auto-fix: call mcp__ccd_pr__set_monitor with auto_fix and address_comments true and this url (the open-pr skill).`,
      );
    }
    if (pull?.state === "MERGED" && wantsCheck && REFS.test(pull.body)) {
      owed.push(
        `Pull request #${number} has merged and its issues are unchecked: run the recheck-issues skill with ${number}.`,
      );
    }
  }
  return owed;
}

function sessionOf(input: HookInput): Session | null {
  try {
    return readSession(readFileSync(String(input.transcript_path), "utf8"));
  } catch {
    return null;
  }
}

/** What the branch changes, in the directory the command runs in. */
function changedFiles(command: string, cwd: string): string[] {
  const dir = CD.exec(command)?.[1]?.replace(/^["']|["']$/g, "");
  try {
    const output = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
      cwd: resolve(cwd, dir ?? "."),
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function viewPull(pr: string, cwd: string): Pull | null {
  try {
    const output = execFileSync("gh", ["pr", "view", pr, "--json", "state,body"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function deny(reason: string): void {
  const hookSpecificOutput = {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  };
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

function edit(input: HookInput): void {
  // A subagent's Skill call lands in its own transcript, so it could never
  // meet this; the branch still answers to the gate on `gh pr create`.
  if (input.agent_id) return;
  const file = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "");
  if (!SKILLS.some(({ paths, beforeTheEdit }) => beforeTheEdit && paths.test(file))) return;
  const session = sessionOf(input);
  const reason = session && editRefusal(session, file);
  if (reason) deny(reason);
}

function create(input: HookInput): void {
  const command = String(input.tool_input?.command ?? "");
  if (!CREATE.test(command)) return;
  const session = sessionOf(input);
  const reason = session && refusal(session, () => changedFiles(command, input.cwd ?? "."));
  if (reason) deny(reason);
}

function stop(input: HookInput): void {
  if (input.stop_hook_active) return;
  const session = sessionOf(input);
  if (!session) return;
  const desktop = process.env.CLAUDE_CODE_ENTRYPOINT === "claude-desktop";
  const owed = duties(session, desktop, (pr) => viewPull(pr, input.cwd ?? "."));
  if (owed.length === 0) return;
  process.stdout.write(JSON.stringify({ decision: "block", reason: owed.join(" ") }));
}

function selfTest(): void {
  const failed: string[] = [];
  const same = (name: string, got: unknown, expected: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      failed.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    }
  };
  const url = "https://github.com/kuutti-ry/kuutti-app/pull/7";
  const call = (id: string, name: string, input: Record<string, unknown>) =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id, name, input }] },
    });
  const result = (id: string, content: unknown, is_error = false) =>
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] },
    });
  const bash = (id: string, command: string) => call(id, "Bash", { command });
  const opened = [bash("a", 'cd x && gh pr create --title "t"'), result("a", url)];
  const read = (...lines: string[]) => readSession(lines.join("\n"));

  for (const [command, matches] of [
    ["gh pr create --fill", true],
    ["cd x && gh pr create --fill", true],
    ["git push\ngh pr create", true],
    ["URL=$(gh pr create --fill)", true],
    ["GH_TOKEN=x gh pr create", true],
    ["grep 'gh pr create' CLAUDE.md", false],
    ["gh pr view 1", false],
    ["echo gh pr create", false],
  ] as const) {
    same(`CREATE on ${command}`, CREATE.test(command), matches);
  }

  same("a line that is no JSON is passed over", [...read("nope", ...opened).opened], [url]);
  same(
    "a failed gh pr create opens nothing",
    [...read(bash("a", "gh pr create"), result("a", `${url} exists`, true)).opened],
    [],
  );
  same(
    "a create with no url opens nothing",
    [...read(bash("a", "gh pr create"), result("a", "nothing to do")).opened],
    [],
  );
  same(
    "a result that is a block list",
    [...read(bash("a", "gh pr create"), result("a", [{ type: "text", text: url }])).opened],
    [url],
  );
  same(
    "a Skill call with its arguments",
    read(call("a", "Skill", { skill: "recheck-issues", args: "7" })).skills.get("recheck-issues"),
    " 7",
  );
  same(
    "a skill typed as a command",
    read(
      JSON.stringify({
        type: "user",
        message: {
          content: "<command-name>/recheck-issues</command-name>\n<command-args>7 8</command-args>",
        },
      }),
    ).skills.get("recheck-issues"),
    " 7 8",
  );
  same(
    "the assistant quoting a command runs nothing",
    read(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "<command-name>open-pr</command-name>" }] },
      }),
    ).skills.has("open-pr"),
    false,
  );
  same(
    "a subagent's call is not the session's",
    read(
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "open-pr" } }] },
      }),
    ).skills.size,
    0,
  );
  same(
    "the request blob's copy is not the session's",
    read(
      JSON.stringify({
        type: "api-request-blob",
        message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "open-pr" } }] },
      }),
    ).skills.size,
    0,
  );
  same("a merge by number", [...read(bash("a", "gh pr merge 7 --squash")).merging], ["7"]);
  same("a merge by hash", [...read(bash("a", "gh pr merge #7")).merging], ["7"]);
  same("a merge by url", [...read(bash("a", `gh pr merge ${url} --squash`)).merging], [url]);
  same(
    "a merge in another repository",
    [...read(bash("a", "gh pr merge 7 --repo kuutti-ry/kuutti-app-site")).merging],
    ["https://github.com/kuutti-ry/kuutti-app-site/pull/7"],
  );
  same(
    "a merge of the branch names nothing",
    [...read(bash("a", "gh pr merge --squash")).merging],
    [],
  );
  same(
    "two merges in one command",
    [...read(bash("a", "gh pr merge 7; gh pr merge 8")).merging],
    ["7", "8"],
  );
  same(
    "Auto-fix switched off is not Auto-fix",
    [...read(call("a", "mcp__ccd_pr__set_monitor", { auto_fix: false, url })).autoFix],
    [],
  );

  const none = read();
  const skills = (...names: string[]) =>
    read(...names.map((skill, i) => call(`s${i}`, "Skill", { skill })));
  const code = () => ["apps/api/src/app.ts"];
  const docs = () => ["docs/adr/README.md", "apps/mobile/README.md", "package.json"];
  const then = "first, then open the pull request (CLAUDE.md, Git).";
  const openOnly = `Run the open-pr skill ${then}`;
  const both = `Run the write-tests and open-pr skills ${then}`;
  same("no skill, no code", refusal(none, docs), openOnly);
  same("no skill, code", refusal(none, code), both);
  same(
    "open-pr alone on code",
    refusal(skills("open-pr"), code),
    `Run the write-tests skill ${then}`,
  );
  same("write-tests alone", refusal(skills("write-tests"), docs), openOnly);
  same("both on code", refusal(skills("write-tests", "open-pr"), code), null);
  same("open-pr on docs", refusal(skills("open-pr"), docs), null);
  const everything = () => [
    "packages/db/src/schema/profile.ts",
    "apps/api/src/matching/rounds.ts",
    "apps/mobile/src/features/chat/Thread.tsx",
  ];
  same(
    "every skill owed, in the order the work meets it",
    refusal(none, everything),
    `Run the personal-data, change-rule, write-tests, check-screen, and open-pr skills ${then}`,
  );
  same(
    "none owed once each has run",
    refusal(
      skills("personal-data", "change-rule", "write-tests", "check-screen", "open-pr"),
      everything,
    ),
    null,
  );
  for (const [file, expected] of [
    ["packages/db/src/schema/profile.ts", "personal-data"],
    ["packages/db/drizzle/0090_x.sql", "personal-data"],
    ["/Users/x/kuutti-app/packages/db/src/schema/chat.ts", "personal-data"],
    ["apps/api/src/matching/rounds.ts", "change-rule"],
    ["apps/api/src/pond/routes.ts", "change-rule"],
    ["apps/api/src/rewards/repo.ts", "change-rule"],
    ["apps/api/src/notifications/push.ts", "change-rule"],
    ["apps/api/src/research/track.ts", "change-rule"],
    ["apps/mobile/src/features/matching/Round.tsx", "change-rule"],
    ["apps/mobile/src/features/profile/Card.tsx", "change-rule"],
    ["features/matching/rounds.feature", "change-rule"],
    ["packages/schema/src/research.ts", "change-rule"],
    ["docs/decisions.md", "change-rule"],
    ["/Users/x/.claude/worktrees/a/apps/api/src/matching/rounds.ts", "change-rule"],
    ["apps/api/src/matching/rounds.test.ts", null],
    ["apps/mobile/src/features/profile/Card.test.tsx", null],
    ["apps/api/src/chat/repo.ts", null],
    ["apps/api/src/identity/erasure.ts", null],
    ["packages/db/src/seed.ts", null],
    ["docs/adr/README.md", null],
    ["", null],
  ] as const) {
    same(
      `the edit of ${file}`,
      editRefusal(none, file),
      expected && `Run the ${expected} skill before editing this file (CLAUDE.md).`,
    );
  }
  same(
    "an edit once its skill has run",
    editRefusal(skills("change-rule"), "apps/api/src/matching/rounds.ts"),
    null,
  );
  for (const [file, expected] of [
    ["apps/mobile/app/(tabs)/index.tsx", true],
    ["apps/mobile/src/features/chat/Thread.tsx", true],
    ["apps/mobile/src/components/ui/button.tsx", true],
    ["apps/admin/src/features/safety/Queue.tsx", true],
    ["apps/mobile/src/features/chat/Thread.test.tsx", false],
    ["apps/mobile/src/features/chat/client.ts", false],
    ["apps/api/src/app.tsx", false],
  ] as const) {
    same(`${file} as a screen`, SCREENS.test(file), expected);
  }
  for (const file of [
    "apps/admin/src/App.tsx",
    "packages/db/src/seed.ts",
    "services/x/a.ts",
    "scripts/e2e.ts",
    ".claude/hooks/skill-gates.ts",
    "features/pond/opening.feature",
  ]) {
    same(`${file} is code`, CODE.test(file), true);
  }

  const session = (...extra: string[]) => read(...opened, ...extra);
  const fixed = call("f", "mcp__ccd_pr__set_monitor", { auto_fix: true, url });
  const check = call("c", "Skill", { skill: "recheck-issues", args: "7" });
  const pull =
    (state: string, body = "Refs #3") =>
    () => ({ state, body });
  const autoFix = `Pull request ${url} has no Auto-fix: call mcp__ccd_pr__set_monitor with auto_fix and address_comments true and this url (the open-pr skill).`;
  const recheck =
    "Pull request #7 has merged and its issues are unchecked: run the recheck-issues skill with 7.";
  same("open without Auto-fix", duties(session(), true, pull("OPEN")), [autoFix]);
  same("open with Auto-fix", duties(session(fixed), true, pull("OPEN")), []);
  same("open outside the app", duties(session(), false, pull("OPEN")), []);
  same("merged, unchecked", duties(session(fixed), true, pull("MERGED")), [recheck]);
  same("merged, checked", duties(session(fixed, check), true, pull("MERGED")), []);
  same("merged with no Auto-fix owes only the check", duties(session(), true, pull("MERGED")), [
    recheck,
  ]);
  same("merged outside the app", duties(session(), false, pull("MERGED")), [recheck]);
  same(
    "merged with no issue",
    duties(session(fixed), true, pull("MERGED", "Bumps a dependency")),
    [],
  );
  same(
    "a qualified reference",
    duties(session(fixed), true, pull("MERGED", "Why.\n\nRefs kuutti-ry/kuutti-app#3")),
    [recheck],
  );
  same("closed unmerged", duties(session(), true, pull("CLOSED")), []);
  same(
    "GitHub does not answer",
    duties(session(), true, () => null),
    [],
  );
  same(
    "a merged number the session did not open",
    duties(read(bash("a", "gh pr merge 7")), true, pull("MERGED")),
    [recheck],
  );
  same(
    "a check of another pull request does not count",
    duties(
      session(fixed, call("c", "Skill", { skill: "recheck-issues", args: "8" })),
      true,
      pull("MERGED"),
    ),
    [recheck],
  );
  same(
    "opened and merged here is one duty",
    duties(session(fixed, bash("m", "gh pr merge 7")), true, pull("MERGED")),
    [recheck],
  );
  let views = 0;
  duties(session(fixed, check), true, () => {
    views += 1;
    return null;
  });
  same("nothing owed asks GitHub nothing", views, 0);

  // The two hooks as Claude Code runs them, with a gh that answers from a file.
  const dir = mkdtempSync(join(tmpdir(), "skill-gates-"));
  const repo = join(dir, "repo");
  const answer = join(dir, "answer");
  const transcript = join(dir, "session.jsonl");
  const gh = join(dir, "gh");
  writeFileSync(gh, `#!/bin/sh\ncat "${answer}"\n`);
  chmodSync(gh, 0o755);
  const hook = (mode: string, input: unknown, env: NodeJS.ProcessEnv = {}) =>
    execFileSync(process.execPath, [import.meta.filename, mode], {
      input: typeof input === "string" ? input : JSON.stringify(input),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...process.env,
        CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
        PATH: `${dir}${delimiter}${process.env.PATH}`,
        ...env,
      },
    });
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: repo,
      stdio: "ignore",
    });
  mkdirSync(join(repo, "apps"), { recursive: true });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(repo, "apps", "a.ts"), "");
  git("add", ".");
  git("commit", "-q", "-m", "code");

  const asked = { transcript_path: transcript, cwd: repo };
  const denied = (reason: string) =>
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    });
  const opening = { ...asked, tool_input: { command: "gh pr create --fill" } };
  writeFileSync(transcript, "");
  same("create: code on the branch", hook("create", opening), denied(both));
  same(
    "create: the directory of the command's cd",
    hook("create", {
      ...opening,
      cwd: dir,
      tool_input: { command: `cd "${repo}" && gh pr create --fill` },
    }),
    denied(both),
  );
  same(
    "create: a relative cd",
    hook("create", { ...opening, cwd: dir, tool_input: { command: "cd repo && gh pr create" } }),
    denied(both),
  );
  same("create: not a repository", hook("create", { ...opening, cwd: dir }), denied(openOnly));
  same(
    "create: another command",
    hook("create", { ...asked, tool_input: { command: "gh pr view" } }),
    "",
  );
  same("create: no command", hook("create", asked), "");
  same(
    "create: no transcript",
    hook("create", { ...opening, transcript_path: join(dir, "x") }),
    "",
  );
  same("create: input that is no JSON", hook("create", "nope"), "");
  writeFileSync(
    transcript,
    ["write-tests", "open-pr"].map((skill) => call(skill, "Skill", { skill })).join("\n"),
  );
  same("create: the skills have run", hook("create", opening), "");

  const editing = {
    ...asked,
    tool_input: { file_path: join(repo, "apps/api/src/matching/rounds.ts") },
  };
  const ruleFirst = "Run the change-rule skill before editing this file (CLAUDE.md).";
  writeFileSync(transcript, "");
  same("edit: a rule's file", hook("edit", editing), denied(ruleFirst));
  same(
    "edit: a notebook's path",
    hook("edit", { ...asked, tool_input: { notebook_path: join(repo, "docs/decisions.md") } }),
    denied(ruleFirst),
  );
  same("edit: a subagent is not held up", hook("edit", { ...editing, agent_id: "a" }), "");
  same(
    "edit: any other file",
    hook("edit", { ...asked, tool_input: { file_path: join(repo, "README.md") } }),
    "",
  );
  same("edit: no file", hook("edit", asked), "");
  same("edit: no transcript", hook("edit", { ...editing, transcript_path: join(dir, "x") }), "");
  same("edit: input that is no JSON", hook("edit", "nope"), "");
  writeFileSync(transcript, call("c", "Skill", { skill: "change-rule" }));
  same("edit: the skill has run", hook("edit", editing), "");

  writeFileSync(transcript, opened.join("\n"));
  const blocked = (reason: string) => JSON.stringify({ decision: "block", reason });
  writeFileSync(answer, JSON.stringify({ state: "OPEN", body: "Refs #3" }));
  same("stop: Auto-fix owed", hook("stop", asked), blocked(autoFix));
  same("stop: outside the app", hook("stop", asked, { CLAUDE_CODE_ENTRYPOINT: "cli" }), "");
  same("stop: the retry asks nothing", hook("stop", { ...asked, stop_hook_active: true }), "");
  writeFileSync(answer, JSON.stringify({ state: "MERGED", body: "Refs #3" }));
  same("stop: the check owed", hook("stop", asked), blocked(recheck));
  writeFileSync(answer, "not json");
  same("stop: gh answers nonsense", hook("stop", asked), "");
  rmSync(gh);
  same("stop: no gh at all", hook("stop", asked, { PATH: dir }), "");
  same("stop: no transcript", hook("stop", { ...asked, transcript_path: join(dir, "x") }), "");
  same("stop: input that is no JSON", hook("stop", "nope"), "");
  rmSync(dir, { recursive: true });

  if (failed.length > 0) {
    for (const failure of failed) console.error(`✖ self-test, ${failure}`);
    process.exit(1);
  }
  console.log("✔ skill-gates self-test");
}

const mode = process.argv[2];
if (mode === "--self-test") {
  selfTest();
} else if (mode === "edit" || mode === "create" || mode === "stop") {
  let input: HookInput;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  ({ edit, create, stop })[mode](input);
}
