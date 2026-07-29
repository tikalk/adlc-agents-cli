import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  installDispatcher,
  installEvents,
  removeEvents,
  resolveEvents,
  readLocalEventsManifest,
} from "../src/events.mjs";
import {
  EVENT_AGENTS,
  getEventAgentConfig,
  CANONICAL_EVENTS,
  BODY_INJECTION_EVENTS,
  EVENT_MARKER,
  DISPATCHER_REL,
} from "../src/registry.mjs";

const SAMPLE_MANIFEST = {
  events: {
    session_start: [
      { skill: "team-boot", description: "Bootstrap session", timeout: 60 },
    ],
    user_prompt_submit: [
      { skill: "team-discover", description: "Fetch context", timeout: 30 },
    ],
  },
};

function createTestProject(withSkills = true) {
  const dir = mkdtempSync(join(tmpdir(), "adlc-test-"));
  if (withSkills) {
    const skillsDir = join(dir, ".agents", "skills");
    mkdirSync(join(skillsDir, "team-boot"), { recursive: true });
    writeFileSync(
      join(skillsDir, "team-boot", "SKILL.md"),
      `---
name: team-boot
description: Bootstrap session with team context
---

# team-boot

Read .adlc/init-options.json then load constitution.`,
      "utf-8",
    );
    mkdirSync(join(skillsDir, "team-discover"), { recursive: true });
    writeFileSync(
      join(skillsDir, "team-discover", "SKILL.md"),
      `---
name: team-discover
description: Fetch relevant team context
---

# team-discover

Match the prompt against CDR index.`,
      "utf-8",
    );
  }
  return dir;
}

describe("Events: manifest discovery", () => {
  it("reads local .events.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "adlc-manifest-"));
    try {
      writeFileSync(join(dir, ".events.json"), JSON.stringify(SAMPLE_MANIFEST), "utf-8");
      const manifest = readLocalEventsManifest(dir);
      assert.deepEqual(Object.keys(manifest.events), ["session_start", "user_prompt_submit"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no .events.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "adlc-none-"));
    try {
      assert.equal(readLocalEventsManifest(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Events: resolution", () => {
  it("resolves events for an event-capable agent", () => {
    const agentConfig = getEventAgentConfig("opencode");
    const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
    assert.ok(resolved.session_start);
    assert.ok(resolved.user_prompt_submit);
    assert.equal(resolved.session_start[0].skill, "team-boot");
    assert.equal(resolved.session_start[0].timeout, 60);
  });

  it("returns empty for empty manifest", () => {
    const agentConfig = getEventAgentConfig("opencode");
    const resolved = resolveEvents(null, agentConfig);
    assert.deepEqual(resolved, {});
  });
});

describe("Events: dispatcher installation", () => {
  it("installs dispatcher to .agents/dispatcher.mjs", () => {
    const projectRoot = createTestProject(false);
    try {
      const path = installDispatcher(projectRoot);
      assert.ok(path.replace(/\\/g, "/").endsWith(".agents/dispatcher.mjs"), `Path: ${path}`);
      assert.ok(existsSync(path));
      const content = readFileSync(path, "utf-8");
      assert.ok(content.includes("Script path") || content.includes("script"));
      assert.ok(content.includes("Body path") || content.includes("body"));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Events: opencode plugin generation", () => {
  it("generates TS plugin with event hooks", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("opencode");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      const result = installEvents("opencode", projectRoot, resolved, ".agents/skills");
      assert.equal(result.path, ".opencode/plugin/adlc-agents-events.ts");
      const content = readFileSync(join(projectRoot, result.path), "utf-8");
      assert.ok(content.includes("AdlcEventsPlugin"));
      assert.ok(content.includes("runEvent"));
      assert.ok(content.includes("team-boot"));
      assert.ok(content.includes("team-discover"));
      assert.ok(content.includes("experimental.chat.system.transform"), "session_start → system.transform hook");
      assert.ok(content.includes("chat.message"), "user_prompt_submit → chat.message hook");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Events: Claude Code JSON merge", () => {
  it("merges hooks into existing settings.json preserving user content", () => {
    const projectRoot = createTestProject(false);
    try {
      // Pre-existing settings with user content
      mkdirSync(join(projectRoot, ".claude"));
      writeFileSync(
        join(projectRoot, ".claude", "settings.json"),
        JSON.stringify({ someSetting: true }, null, 2),
        "utf-8",
      );

      const agentConfig = getEventAgentConfig("claude-code");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      const result = installEvents("claude-code", projectRoot, resolved, ".agents/skills");
      assert.ok(result.merged);

      const settings = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.json"), "utf-8"));
      assert.ok(settings.someSetting, "Pre-existing setting preserved");
      assert.ok(settings.hooks, "Hooks added");
      assert.ok(settings.hooks.SessionStart, "SessionStart hook added");
      assert.ok(settings.hooks.UserPromptSubmit, "UserPromptSubmit hook added");
      assert.equal(settings.hooks.SessionStart[0][EVENT_MARKER], true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("idempotent merge: re-install does not duplicate entries", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("claude-code");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("claude-code", projectRoot, resolved, ".agents/skills");
      installEvents("claude-code", projectRoot, resolved, ".agents/skills");

      const settings = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.json"), "utf-8"));
      assert.equal(settings.hooks.SessionStart.length, 1, "No duplicate SessionStart entries");
      assert.equal(settings.hooks.UserPromptSubmit.length, 1, "No duplicate UserPromptSubmit entries");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("JSONC preservation: malformed JSON aborts, does not reset", () => {
    const projectRoot = createTestProject(false);
    try {
      mkdirSync(join(projectRoot, ".claude"));
      const badJson = '{ "hooks": { broken';
      writeFileSync(join(projectRoot, ".claude", "settings.json"), badJson, "utf-8");

      const agentConfig = getEventAgentConfig("claude-code");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      const result = installEvents("claude-code", projectRoot, resolved, ".agents/skills");
      assert.equal(result.error, "parse-failed-preserved");

      // File should be UNCHANGED
      const content = readFileSync(join(projectRoot, ".claude", "settings.json"), "utf-8");
      assert.equal(content, badJson, "Malformed file preserved, not reset");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Events: Copilot JSON generation", () => {
  it("generates dedicated hooks file", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("github-copilot");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      const result = installEvents("github-copilot", projectRoot, resolved, ".agents/skills");
      assert.equal(result.path, ".github/hooks/adlc-agents.json");

      const content = JSON.parse(readFileSync(join(projectRoot, result.path), "utf-8"));
      assert.ok(content.sessionStart);
      assert.ok(content.userPromptSubmitted);
      assert.equal(content.sessionStart[0].type, "command");
      assert.ok(content.sessionStart[0].bash);
      assert.ok(content.sessionStart[0].powershell);
      assert.ok(content.sessionStart[0].bash.includes("/"), "bash uses POSIX paths");
      assert.ok(content.sessionStart[0].powershell.includes("\\"), "powershell uses Windows paths");
      assert.equal(content.sessionStart[0][EVENT_MARKER], true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Events: surgical teardown", () => {
  it("removes marker entries from Claude settings, preserves user hooks", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("claude-code");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("claude-code", projectRoot, resolved, ".agents/skills");

      // Add a user-created hook manually
      const settingsPath = join(projectRoot, ".claude", "settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      settings.hooks.SessionStart.push({ type: "command", command: "echo user-hook" });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

      // Remove our events
      const result = removeEvents("claude-code", projectRoot);
      assert.equal(result.action, "cleaned");

      const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
      assert.equal(after.hooks.SessionStart.length, 1, "Only user hook remains");
      assert.equal(after.hooks.SessionStart[0].command, "echo user-hook");
      assert.equal(after.hooks.UserPromptSubmit, undefined, "Our entries removed");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("deletes opencode plugin file (marker present)", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("opencode");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("opencode", projectRoot, resolved, ".agents/skills");

      const pluginPath = join(projectRoot, ".opencode/plugin/adlc-agents-events.ts");
      assert.ok(existsSync(pluginPath));

      const result = removeEvents("opencode", projectRoot);
      assert.equal(result.action, "deleted");
      assert.ok(!existsSync(pluginPath));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Dispatcher: execution paths", () => {
  it("body path: outputs skill body when no scripts:", () => {
    const projectRoot = createTestProject(true);
    try {
      installDispatcher(projectRoot);
      const dispatcher = join(projectRoot, DISPATCHER_REL);
      const skillsDir = join(projectRoot, ".agents", "skills");

      const result = spawnSync("node", [dispatcher, "session_start", "team-boot", skillsDir, "10"], {
        encoding: "utf-8",
        cwd: projectRoot,
      });

      assert.equal(result.status, 0, `dispatcher exited ${result.status}: ${result.stderr}`);
      assert.ok(result.stdout.includes("Read .adlc/init-options.json"), "Body output present");
      assert.ok(!result.stdout.startsWith("---"), "Frontmatter stripped");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("script path: runs skill's script when scripts: present", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "adlc-script-"));
    try {
      // Create skill with a script
      const skillsDir = join(projectRoot, ".agents", "skills");
      mkdirSync(join(skillsDir, "boot-skill"), { recursive: true });
      writeFileSync(
        join(skillsDir, "boot-skill", "SKILL.md"),
        `---
name: boot-skill
description: Bootstrap with a script
scripts:
  sh: scripts/boot.sh
---

# boot-skill

Body should NOT be output when script runs.`,
        "utf-8",
      );
      mkdirSync(join(skillsDir, "boot-skill", "scripts"), { recursive: true });
      writeFileSync(
        join(skillsDir, "boot-skill", "scripts", "boot.sh"),
        `#!/bin/bash
echo "SCRIPT_OUTPUT: constitution loaded"`,
        "utf-8",
      );
      const scriptPath = join(skillsDir, "boot-skill", "scripts", "boot.sh");
      try { chmodSync(scriptPath, 0o755); } catch {}

      installDispatcher(projectRoot);
      const dispatcher = join(projectRoot, DISPATCHER_REL);

      const result = spawnSync("node", [dispatcher, "session_start", "boot-skill", skillsDir, "10"], {
        encoding: "utf-8",
        cwd: projectRoot,
      });

      assert.equal(result.status, 0, `dispatcher exited ${result.status}: ${result.stderr}`);
      assert.ok(result.stdout.includes("SCRIPT_OUTPUT: constitution loaded"), "Script output present");
      assert.ok(!result.stdout.includes("Body should NOT"), "Body NOT output when script runs");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("fail-open: missing skill logs and exits 0", () => {
    const projectRoot = createTestProject(true);
    try {
      installDispatcher(projectRoot);
      const dispatcher = join(projectRoot, DISPATCHER_REL);
      const skillsDir = join(projectRoot, ".agents", "skills");

      const result = spawnSync("node", [dispatcher, "session_start", "nonexistent", skillsDir, "10"], {
        encoding: "utf-8",
        cwd: projectRoot,
      });

      assert.equal(result.status, 0, "fail-open exits 0");
      assert.ok(result.stderr.includes("not found"), "Error logged to stderr");
      assert.equal(result.stdout, "", "No stdout output");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Registry: events data", () => {
  it("has 6 canonical events", () => {
    assert.equal(CANONICAL_EVENTS.length, 6);
    assert.ok(CANONICAL_EVENTS.includes("session_start"));
    assert.ok(CANONICAL_EVENTS.includes("user_prompt_submit"));
    assert.ok(CANONICAL_EVENTS.includes("pre_tool_use"));
    assert.ok(CANONICAL_EVENTS.includes("post_tool_use"));
    assert.ok(CANONICAL_EVENTS.includes("session_end"));
    assert.ok(CANONICAL_EVENTS.includes("stop"));
  });

  it("body injection applies to session_start and user_prompt_submit only", () => {
    assert.ok(BODY_INJECTION_EVENTS.has("session_start"));
    assert.ok(BODY_INJECTION_EVENTS.has("user_prompt_submit"));
    assert.ok(!BODY_INJECTION_EVENTS.has("pre_tool_use"));
    assert.ok(!BODY_INJECTION_EVENTS.has("session_end"));
  });

  it("9 event agents configured", () => {
    const keys = Object.keys(EVENT_AGENTS).sort();
    assert.deepEqual(keys, [
      "claude-code",
      "codex",
      "cursor",
      "devin",
      "gemini-cli",
      "github-copilot",
      "opencode",
      "qwen-code",
      "tabnine-cli",
    ]);
  });

  it("every event agent has canonical_to_native entries for all 6 events (null = unsupported)", () => {
    for (const [key, config] of Object.entries(EVENT_AGENTS)) {
      for (const event of CANONICAL_EVENTS) {
        assert.ok(
          event in config.canonical_to_native,
          `Agent ${key} missing canonical_to_native entry for ${event}`,
        );
      }
    }
  });
});

describe("Events: Codex TOML generation", () => {
  it("generates TOML config with hooks blocks", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("codex");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      const result = installEvents("codex", projectRoot, resolved, ".agents/skills");
      assert.equal(result.path, ".codex/config.toml");

      const content = readFileSync(join(projectRoot, result.path), "utf-8");
      assert.ok(content.includes("[[hooks.SessionStart]]"));
      assert.ok(content.includes("[[hooks.UserPromptSubmit]]"));
      assert.ok(content.includes("type = \"command\""));
      assert.ok(content.includes("adlc_marker = true"));
      assert.ok(content.includes("timeout = 60"), "Codex uses seconds");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("idempotent: re-install does not duplicate TOML blocks", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("codex");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("codex", projectRoot, resolved, ".agents/skills");
      installEvents("codex", projectRoot, resolved, ".agents/skills");

      const content = readFileSync(join(projectRoot, ".codex/config.toml"), "utf-8");
      const sessionStartCount = (content.match(/\[\[hooks\.SessionStart\]\]/g) || []).length;
      assert.equal(sessionStartCount, 1, "No duplicate SessionStart TOML blocks");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("teardown strips marker blocks, preserves user TOML", () => {
    const projectRoot = createTestProject(false);
    try {
      mkdirSync(join(projectRoot, ".codex"), { recursive: true });
      writeFileSync(
        join(projectRoot, ".codex", "config.toml"),
        `# user config\nsome_setting = true\n\n[[hooks.SessionStart]]\nmatcher = "*"\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "echo user"\n`,
        "utf-8",
      );

      const agentConfig = getEventAgentConfig("codex");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("codex", projectRoot, resolved, ".agents/skills");

      const result = removeEvents("codex", projectRoot);
      assert.equal(result.action, "cleaned");

      const after = readFileSync(join(projectRoot, ".codex/config.toml"), "utf-8");
      assert.ok(after.includes("echo user"), "User hook preserved");
      assert.ok(after.includes("some_setting = true"), "User config preserved");
      assert.ok(!after.includes("adlc_marker"), "Our marker blocks removed");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Events: Gemini ms timeout conversion", () => {
  it("converts timeout to milliseconds", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("gemini-cli");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      const result = installEvents("gemini-cli", projectRoot, resolved, ".agents/skills");

      const content = JSON.parse(readFileSync(join(projectRoot, result.path), "utf-8"));
      assert.ok(content.hooks.SessionStart, "SessionStart present");
      assert.equal(content.hooks.SessionStart[0].timeout, 60000, "60s → 60000ms");
      assert.equal(content.hooks.BeforeAgent[0].timeout, 30000, "30s → 30000ms");
      assert.ok(content.hooks.SessionStart[0][EVENT_MARKER], "Marker present");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("uses Gemini native event names (BeforeTool, AfterAgent)", () => {
    const projectRoot = createTestProject(false);
    try {
      const manifest = {
        events: {
          pre_tool_use: [{ skill: "audit", timeout: 10 }],
          stop: [{ skill: "cleanup", timeout: 5 }],
        },
      };
      const agentConfig = getEventAgentConfig("gemini-cli");
      const resolved = resolveEvents(manifest, agentConfig);
      installEvents("gemini-cli", projectRoot, resolved, ".agents/skills");

      const content = JSON.parse(readFileSync(join(projectRoot, ".gemini/settings.json"), "utf-8"));
      assert.ok(content.hooks.BeforeTool, "pre_tool_use → BeforeTool");
      assert.ok(content.hooks.AfterAgent, "stop → AfterAgent");
      assert.equal(content.hooks.BeforeTool[0].timeout, 10000, "10s → 10000ms");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Events: Devin root-nested JSON", () => {
  it("generates hooks at root level (no hooks wrapper)", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("devin");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      const result = installEvents("devin", projectRoot, resolved, ".agents/skills");
      assert.equal(result.path, ".devin/hooks.v1.json");

      const content = JSON.parse(readFileSync(join(projectRoot, result.path), "utf-8"));
      assert.ok(content.SessionStart, "SessionStart at root");
      assert.ok(content.UserPromptSubmit, "UserPromptSubmit at root");
      assert.ok(!content.hooks, "No hooks wrapper (root-nested)");
      assert.equal(content.SessionStart[0][EVENT_MARKER], true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("teardown removes root-level marker entries", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("devin");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("devin", projectRoot, resolved, ".agents/skills");

      // Add a user hook at root
      const path = join(projectRoot, ".devin/hooks.v1.json");
      const data = JSON.parse(readFileSync(path, "utf-8"));
      data.SessionStart.push({ type: "command", command: "echo user" });
      writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");

      const result = removeEvents("devin", projectRoot);
      assert.equal(result.action, "cleaned");

      const after = JSON.parse(readFileSync(path, "utf-8"));
      assert.equal(after.SessionStart.length, 1, "User hook preserved");
      assert.equal(after.SessionStart[0].command, "echo user");
      assert.equal(after.UserPromptSubmit, undefined, "Our entries removed");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Events: Tabnine ms timeout", () => {
  it("converts timeout to ms and uses Gemini-compatible names", () => {
    const projectRoot = createTestProject(false);
    try {
      const manifest = {
        events: {
          session_start: [{ skill: "boot", timeout: 45 }],
          post_tool_use: [{ skill: "audit", timeout: 15 }],
        },
      };
      const agentConfig = getEventAgentConfig("tabnine-cli");
      const resolved = resolveEvents(manifest, agentConfig);
      installEvents("tabnine-cli", projectRoot, resolved, ".agents/skills");

      const content = JSON.parse(readFileSync(join(projectRoot, ".tabnine/agent/settings.json"), "utf-8"));
      assert.ok(content.hooks.SessionStart, "SessionStart present");
      assert.ok(content.hooks.AfterTool, "post_tool_use → AfterTool");
      assert.equal(content.hooks.SessionStart[0].timeout, 45000, "45s → 45000ms");
      assert.equal(content.hooks.AfterTool[0].timeout, 15000, "15s → 15000ms");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("Events: Qwen ms timeout", () => {
  it("converts timeout to ms", () => {
    const projectRoot = createTestProject(false);
    try {
      const agentConfig = getEventAgentConfig("qwen-code");
      const resolved = resolveEvents(SAMPLE_MANIFEST, agentConfig);
      installEvents("qwen-code", projectRoot, resolved, ".agents/skills");

      const content = JSON.parse(readFileSync(join(projectRoot, ".qwen/settings.json"), "utf-8"));
      assert.ok(content.hooks.SessionStart, "SessionStart present");
      assert.ok(content.hooks.UserPromptSubmit, "UserPromptSubmit present");
      assert.equal(content.hooks.SessionStart[0].timeout, 60000, "60s → 60000ms");
      assert.equal(content.hooks.UserPromptSubmit[0].timeout, 30000, "30s → 30000ms");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
