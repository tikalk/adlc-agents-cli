import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "../src/frontmatter.mjs";

describe("Frontmatter parsing", () => {
  it("parses simple key-value frontmatter", () => {
    const content = `---
name: team-setup
description: Clone, scaffold, or configure a team AI directives repository
---

# Team Setup

Body text here.`;

    const { frontmatter, body } = parseFrontmatter(content);
    assert.equal(frontmatter.name, "team-setup");
    assert.equal(frontmatter.description, "Clone, scaffold, or configure a team AI directives repository");
    assert.ok(body.startsWith("# Team Setup"));
  });

  it("parses quoted values", () => {
    const content = `---
name: "my-skill"
description: 'A skill with: a colon'
---

Body`;

    const { frontmatter } = parseFrontmatter(content);
    assert.equal(frontmatter.name, "my-skill");
    assert.equal(frontmatter.description, "A skill with: a colon");
  });

  it("parses disable-model-invocation field", () => {
    const content = `---
name: team-setup
description: A skill
disable-model-invocation: true
---

Body`;

    const { frontmatter } = parseFrontmatter(content);
    assert.equal(frontmatter["disable-model-invocation"], "true");
  });

  it("returns null frontmatter for content without frontmatter", () => {
    const content = "# Just markdown\n\nNo frontmatter.";
    const { frontmatter, body } = parseFrontmatter(content);
    assert.equal(frontmatter, null);
    assert.equal(body, content);
  });

  it("returns null frontmatter for unclosed frontmatter", () => {
    const content = "---\nname: broken\nNo closing delimiter";
    const { frontmatter } = parseFrontmatter(content);
    assert.equal(frontmatter, null);
  });

  it("handles empty description", () => {
    const content = `---
name: minimal
---

Body`;

    const { frontmatter } = parseFrontmatter(content);
    assert.equal(frontmatter.name, "minimal");
    assert.equal(frontmatter.description, undefined);
  });
});
