import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findInstalledSkills, detectAdlc } from "../src/source.mjs";
import { generateCommand, commandFilename, isGenerated, removeGeneratedCommands } from "../src/convert.mjs";
import { getAgent } from "../src/registry.mjs";

function createTestProject() {
  const dir = mkdtempSync(join(tmpdir(), "adlc-test-"));

  // Create a fake skills directory with SKILL.md files
  const skillsDir = join(dir, ".agents", "skills");
  mkdirSync(join(skillsDir, "team-setup"), { recursive: true });
  writeFileSync(
    join(skillsDir, "team-setup", "SKILL.md"),
    `---
name: team-setup
description: Clone, scaffold, or configure a team AI directives repository
---

# Team Setup

This is the skill body.`,
    "utf-8",
  );

  mkdirSync(join(skillsDir, "mission-brief"), { recursive: true });
  writeFileSync(
    join(skillsDir, "mission-brief", "SKILL.md"),
    `---
name: mission-brief
description: End-to-end mission pipeline
---

# Mission Brief

Body text.`,
    "utf-8",
  );

  return dir;
}

describe("E2E: skill discovery + command generation", () => {
  it("finds installed skills and generates commands", async () => {
    const projectRoot = createTestProject();

    try {
      const skills = await findInstalledSkills(".agents/skills", projectRoot);
      assert.equal(skills.length, 2);

      const names = skills.map((s) => s.name).sort();
      assert.deepEqual(names, ["mission-brief", "team-setup"]);

      // Generate commands for opencode
      const agent = getAgent("opencode");
      const commandsDir = join(projectRoot, ".opencode", "commands");
      mkdirSync(commandsDir, { recursive: true });

      for (const skill of skills) {
        const filename = commandFilename(skill, agent, { source: "test-repo" });
        const content = generateCommand(skill, agent, { source: "test-repo" });
        writeFileSync(join(commandsDir, filename), content, "utf-8");
      }

      // Verify files exist and are generated
      const setupContent = readFileSync(join(commandsDir, "team-setup.md"), "utf-8");
      assert.ok(isGenerated(setupContent));
      assert.ok(setupContent.includes("Clone, scaffold, or configure"));
      assert.ok(setupContent.includes("Invoke the `team-setup` skill."));

      const briefContent = readFileSync(join(commandsDir, "mission-brief.md"), "utf-8");
      assert.ok(isGenerated(briefContent));
      assert.ok(briefContent.includes("Invoke the `mission-brief` skill."));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("generates commands for multiple agents", async () => {
    const projectRoot = createTestProject();

    try {
      const skills = await findInstalledSkills(".agents/skills", projectRoot);

      for (const agentKey of ["opencode", "claude-code", "gemini-cli"]) {
        const agent = getAgent(agentKey);
        const dir = join(projectRoot, agent.commands_dir);
        mkdirSync(dir, { recursive: true });

        for (const skill of skills) {
          const filename = commandFilename(skill, agent, { source: "test" });
          const content = generateCommand(skill, agent, { source: "test" });
          writeFileSync(join(dir, filename), content, "utf-8");
        }

        // Verify
        const expectedExt = agent.commands_ext;
        const files = skills.map((s) => commandFilename(s, agent, { source: "test" }));
        for (const f of files) {
          assert.ok(existsSync(join(dir, f)), `Missing ${f} for ${agentKey}`);
        }
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("E2E: ADLC detection", () => {
  it("detects ADLC when init-options.json exists", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "adlc-detect-"));

    try {
      mkdirSync(join(projectRoot, ".adlc"));
      writeFileSync(
        join(projectRoot, ".adlc", "init-options.json"),
        JSON.stringify({ team_ai_directives: "/path/to/directives" }),
        "utf-8",
      );

      const result = detectAdlc(projectRoot);
      assert.equal(result, "/path/to/directives");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("returns null when ADLC is not configured", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "adlc-none-"));

    try {
      const result = detectAdlc(projectRoot);
      assert.equal(result, null);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("E2E: removeGeneratedCommands — native-skills legacy cleanup", () => {
  it("deletes only marker-matched generated files, preserves user files", () => {
    const dir = mkdtempSync(join(tmpdir(), "adlc-cleanup-"));

    try {
      const commandsDir = join(dir, ".opencode", "commands");
      mkdirSync(commandsDir, { recursive: true });

      const agent = getAgent("opencode");
      // Two generated command files (CLI-owned)
      for (const name of ["team-setup", "mission-brief"]) {
        const skill = { name, description: `desc ${name}`, body: `# ${name}`, dir: join(dir, ".agents", "skills", name), frontmatter: { name } };
        writeFileSync(join(commandsDir, commandFilename(skill, agent, {})), generateCommand(skill, agent, { source: "test" }), "utf-8");
      }
      // A user-authored command file (no generated header) — must be preserved
      writeFileSync(join(commandsDir, "my-custom.md"), "# My custom command\n\nDo something.", "utf-8");
      // A non-generated file sharing the skill name is impossible by design, but
      // ensure a subdirectory is left alone too
      mkdirSync(join(commandsDir, "subdir"), { recursive: true });

      const removed = removeGeneratedCommands(commandsDir);

      assert.equal(removed, 2, "removed exactly the 2 generated files");
      assert.ok(!existsSync(join(commandsDir, "team-setup.md")), "generated file deleted");
      assert.ok(!existsSync(join(commandsDir, "mission-brief.md")), "generated file deleted");
      assert.ok(existsSync(join(commandsDir, "my-custom.md")), "user file preserved");
      assert.ok(existsSync(join(commandsDir, "subdir")), "subdir preserved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 0 when commands dir does not exist", () => {
    assert.equal(removeGeneratedCommands(join(tmpdir(), "definitely-not-present-xyz")), 0);
  });
});
