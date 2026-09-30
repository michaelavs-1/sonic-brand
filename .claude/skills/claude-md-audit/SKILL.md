---
name: claude-md-audit
description: Scan recent Claude Code session transcripts for changes not yet reflected in CLAUDE.md, produce a punch list of updates, and apply all of them. Use when a session (or a run of recent sessions) made substantial code / architecture / config changes and you want to keep the project's AI context doc fresh. Triggers include "/claude-md-audit", "audit claude.md", "check if claude.md needs updates", "refresh claude.md".
---

# CLAUDE.md audit

You are auditing `CLAUDE.md` against everything the user has actually built in Claude Code over a recent window. Goal: catch stale claims and missing architectural additions **before** they mislead a future session.

## What you're doing

1. **Enumerate recent transcript files** at `~/.claude/projects/d--Projects-algorithm-sonic-brand/*.jsonl`. Default window: the last 7 days. Ask the user to widen the window if they mention a specific longer stretch ("go over the last month"), or narrow it if they only care about the current session.

2. **Extract user turns** from each qualifying transcript. Skip system-reminder blocks, tool-result echoes, and interruption markers. Each user turn's first line is usually enough context to tell what topic was being worked on. Bash + Node one-liner works well:

   ```bash
   node -e "
   const fs = require('fs');
   const dir = 'C:/Users/ronim/.claude/projects/d--Projects-algorithm-sonic-brand';
   const CUTOFF = new Date(Date.now() - 7 * 24 * 3600 * 1000);
   for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
     const st = fs.statSync(dir + '/' + f);
     if (st.mtime < CUTOFF) continue;
     for (const line of fs.readFileSync(dir + '/' + f, 'utf-8').split('\n')) {
       if (!line) continue;
       let o; try { o = JSON.parse(line); } catch { continue; }
       if (o.type !== 'user' || !o.message?.content) continue;
       if (o.timestamp && new Date(o.timestamp) < CUTOFF) continue;
       for (const c of (Array.isArray(o.message.content) ? o.message.content : [])) {
         if (c?.type !== 'text' || !c.text?.trim()) continue;
         if (c.text.startsWith('[Request interrupted') || c.text.startsWith('<system-reminder')) continue;
         console.log('  ' + (o.timestamp||'?').slice(0,16) + '  ' + c.text.split('\n')[0].slice(0,200));
       }
     }
     console.log('---');
   }
   "
   ```

3. **Cross-reference with `CLAUDE.md`**. For every topic you see in the transcripts, ask:
   - Is it already documented?
   - Is what's documented still accurate, or has the code moved on?
   - Are there new files / tables / env vars / architectural pieces that don't appear anywhere in the doc?

   Common signals that CLAUDE.md is stale:
   - A file mentioned in the file-structure tree that no longer exists on disk (`ls` the sandbox / test-page paths mentioned; delete entries for missing dirs).
   - A section describing model X when `PROVIDER` in `v6/generation/ai-provider.js` says something else.
   - Cron schedule notes that don't match `vercel.json crons`.
   - Env var table missing recently-added keys (`grep -rn "process.env" api/` and diff against the table).
   - Data-model table list missing tables that now exist (query Supabase or check migration files under `v5/precompute/migrations/`).
   - Feature flows described using old field names / step numbers (e.g. onboarding step count grew).

4. **Categorize the punch list** into three buckets:
   - **CRITICAL** (wrong-in-place — following the doc would mislead)
   - **IMPORTANT** (missing recent architectural additions — a fresh session wouldn't know these exist)
   - **MINOR** (cleanup — stale file references, resolved known-issues, etc.)

5. **Apply every item — all three buckets.** Don't ask which ones to apply: the user wants the full list applied on every audit. Edit `CLAUDE.md` with `Edit` calls (never `Write` — the file is too big for a full rewrite), in the same turn as the punch list.

## Rules

- **`CLAUDE.md` is the only file you'll edit.** Everything else is read-only for this audit.
- If a change was **contemplated** in a transcript but never landed in code, don't document it as if it did. Verify against the actual files.
- If the punch list is empty, say so plainly. Don't invent updates for the sake of doing work.
- When adding new sections, prefer inserting near thematically-related content over appending to the bottom.
- Keep the section-heading style consistent with existing sections (`###` inside `##`, prose-heavy, code blocks for concrete examples).
- If the doc's structure needs meaningful reorganization (not just individual-section updates), flag it in the punch list but don't do the reorg without explicit approval — that's a bigger conversation. This is the one exception to "apply every item".

## Output shape

Every audit ends with:
- The punch list (numbered, categorized as above)
- The edits, all applied, with a one-line summary of each
- Any reorganization you flagged but didn't do
