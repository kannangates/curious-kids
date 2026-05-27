# 🔍 repo-audit-prd — a reusable Claude skill

A two-in-one engineering skill for any codebase:

1. **Bug Audit** — a systematic, repeatable review pass that catches the bugs
   type-checkers and linters miss: async/race conditions, lifecycle & resource
   leaks, error-classification mistakes, auth/token edge cases, security gaps,
   storage/migration issues, empty states, and regressions.
2. **PRD Generator** — analyses the repository and produces a polished,
   **self-contained HTML PRD** with Mermaid architecture/data/flow diagrams and
   honest `✓ Built` / `◗ Planned` / `⚠ Gap` status badges.

> **Proof of output:** this repo's [`curious-kids-prd.html`](../../curious-kids-prd.html)
> was produced in this style — open it to see what the PRD generator creates.

## Contents
```
repo-audit-prd/
├── SKILL.md                          # the skill definition (frontmatter + instructions)
├── README.md                         # this file
├── references/
│   └── bug-audit-checklist.md        # 12-category checklist the audit walks
└── templates/
    └── prd-template.html             # Mermaid-powered, self-contained PRD scaffold
```

## Install (Claude Code)
Copy the skill folder into your skills directory:

```bash
# project-scoped (only this repo)
mkdir -p .claude/skills && cp -r skills/repo-audit-prd .claude/skills/

# or user-scoped (all your projects)
mkdir -p ~/.claude/skills && cp -r skills/repo-audit-prd ~/.claude/skills/
```

Claude Code auto-discovers skills by their `SKILL.md` frontmatter.

## Use
Just ask, in natural language:

- **Audit:** *"Bug-check the current diff"* · *"Audit this repo for edge cases before I open the PR"*
- **PRD:** *"Generate a PRD for this project"* · *"Create an architecture doc with diagrams"*

The skill scopes the work, reads the code (it builds/type-checks first so it can
focus on the bugs those tools can't catch), and either reports findings by
severity or writes a `<project>-prd.html` you can open in any browser.

## Why it exists
Built while shipping a production React + TypeScript PWA end-to-end with AI.
The audit checklist is distilled from **real bugs caught before they shipped** —
unmounted-state updates, storage-quota crashes, token-expiry handling, and an
error-classifier that was mislabeling API errors as "offline." Codifying that
into a reusable skill keeps every future build honest.

MIT licensed (same as the parent repo).
