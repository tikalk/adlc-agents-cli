// Source resolver — finds SKILL.md files in the agent's skills directory
// after npx skills add has installed them.

import { readdir, stat, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { parseFrontmatter } from "./frontmatter.mjs";

export async function findInstalledSkills(skillsDir, projectRoot = process.cwd()) {
  const absDir = resolve(projectRoot, expandTilde(skillsDir));
  const skills = [];

  try {
    await stat(absDir);
  } catch {
    return skills;
  }

  await scanSkillsDir(absDir, absDir, skills);
  return skills;
}

async function scanSkillsDir(baseDir, currentDir, skills) {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);

    if (entry.name === "SKILL.md") {
      const skill = await loadSkill(fullPath);
      if (skill) skills.push(skill);
      continue;
    }

    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
      await scanSkillsDir(baseDir, fullPath, skills);
    }
  }
}

async function loadSkill(skillPath) {
  let content;
  try {
    content = await readFile(skillPath, "utf-8");
  } catch {
    return null;
  }

  const { frontmatter, body } = parseFrontmatter(content);
  if (!frontmatter || !frontmatter.name) return null;

  return {
    name: frontmatter.name,
    description: frontmatter.description || "",
    body,
    path: skillPath,
    dir: dirname(skillPath),
    frontmatter,
  };
}

export function expandTilde(p) {
  if (p.startsWith("~/") || p === "~") {
    return join(process.env.HOME || process.env.USERPROFILE || "", p.slice(1));
  }
  return p;
}

export function detectAdlc(projectRoot = process.cwd()) {
  const initOptionsPath = join(projectRoot, ".adlc", "init-options.json");
  try {
    const content = readFileSync(initOptionsPath, "utf-8");
    const config = JSON.parse(content);
    return config.team_ai_directives || null;
  } catch {
    return null;
  }
}
