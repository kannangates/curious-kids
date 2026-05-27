---
name: repo-audit-prd
description: >-
  Audit a codebase for bugs, edge cases, race conditions, security issues and
  regressions, and/or generate a beautiful self-contained HTML PRD (with
  Mermaid architecture diagrams) directly from the repository. Use this when
  asked to "bug-check / audit this repo or diff", "review for edge cases before
  shipping / before a PR", or "create / generate a PRD / architecture doc for
  this project".
---

# Repo Audit + PRD

A two-in-one engineering skill:

1. **Bug Audit** — a systematic, repeatable review pass that finds the bugs
   linters and type-checkers miss (async/race conditions, lifecycle leaks,
   security gaps, edge cases, regressions).
2. **PRD Generator** — turns the actual repository into a polished,
   self-contained HTML product/architecture doc with Mermaid diagrams.

Run them independently or back-to-back (audit → fix → regenerate the PRD).

---

## Mode 1 — Bug Audit

Use when the user wants a correctness review of a repo, a diff, or a feature
just built.

**Steps**
1. **Scope it.** Decide what to review: the working diff (`git diff`), a PR
   range (`git diff main...HEAD`), a specific feature, or the whole repo.
   Prefer the smallest meaningful scope; for whole-repo audits, go module by
   module.
2. **Read, don't skim.** Open the relevant files in full. Build/type-check
   first (`tsc --noEmit`, `npm run build`, etc.) so type errors are out of the
   way — this skill targets the bugs those tools *cannot* catch.
3. **Walk the checklist.** Apply every category in
   `references/bug-audit-checklist.md` to the code in scope. For each finding,
   note: file:line, severity (Critical / Medium / Low), the concrete failure
   scenario, and the fix.
4. **Verify, don't assume.** Trace the actual code path before reporting a bug
   ("this throws when X" must be backed by reading the throw site). Re-run the
   build after any fix.
5. **Report.** Group findings by severity. Lead with Critical. Be specific and
   actionable — no generic advice.

**Output format**
```
## Bug Audit — <scope>
### 🔴 Critical
- [file:line] <one-line title> — <failure scenario> → <fix>
### 🟠 Medium
- ...
### 🟡 Low / polish
- ...
### ✅ Checked & clean
- <areas reviewed that were fine>
```

If asked to fix, apply fixes smallest-first, re-run the build after each, and
never mark a task done while the build is red.

---

## Mode 2 — PRD Generation

Use when the user wants a PRD / design doc / architecture overview for the repo.

**Steps**
1. **Understand the repo.** Read `package.json`/manifest, the entry point,
   routing, data layer, state, and the main feature modules. Identify the
   stack, the data model, the key flows, and the security/auth model.
2. **Copy the template.** Start from `templates/prd-template.html` — it is
   self-contained (Mermaid via CDN, dark theme, status badges) and needs no
   build step.
3. **Fill every `{{PLACEHOLDER}}` and `<!-- FILL: ... -->` block** with real,
   repo-derived content. Replace the example Mermaid diagrams with ones that
   reflect the actual architecture (component/data-flow/sequence as fits).
4. **Use build-status badges honestly.** Mark each section/feature
   `✓ Built` / `◗ Planned` based on what truly exists in the code — verify
   against the repo, don't assume.
5. **Save** as `<project-name>-prd.html` at the repo root and open/preview it.

**Diagram guidance** — pick the Mermaid types that fit:
- `flowchart` for architecture / module relationships
- `sequenceDiagram` for a key request/auth flow
- `erDiagram` for the data model
- `timeline` or `gantt` for the roadmap
Keep node labels short; prefer 2–4 focused diagrams over one giant one.

---

## Principles
- **Truth over polish.** Every "Built" badge and every "this is safe" claim
  must be backed by code you actually read.
- **Smallest correct scope.** Don't boil the ocean; review/spec what matters.
- **Self-contained output.** The PRD must open in any browser with no build,
  no local server, no dependencies beyond the Mermaid CDN.

See `README.md` for install/usage and `references/bug-audit-checklist.md` for
the full checklist. A real-world example of this skill's PRD output ships in
this repo as `curious-kids-prd.html`.
