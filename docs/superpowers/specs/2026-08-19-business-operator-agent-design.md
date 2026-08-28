# Business Operator agent - design

Date: 2026-08-19. Status: built (turn 1), provisional defaults pending owner review.
Artifacts: `business/` (README, OPERATOR, GOAL, PLAN, AGENTS, SKILLS, DATA, LOGS),
`.claude/agents/biz-*.md`, `.claude/skills/biz-turn/SKILL.md` (installed by `business/install.sh`).

Storage: the operational `business/` tree and installed `.claude/` files are local and gitignored.
`business/DATA/` contains real lead names, email addresses, and conversation threads, so it must not be
added to git. This tracked design document describes the system without tracking its operational state.

## Problem

ClipClap is live (web + Telegram bot, Stripe + Tribute) with zero revenue. The owner wants an
autonomous agent that runs the commercial loop end to end - research, lead generation,
outreach, closing, onboarding - until N paying customers exist, with three hard
requirements: (1) a Fable 5 orchestrator that plans and directs, (2) all actions executed by
Sonnet 5 subagents for token economy, (3) the orchestrator verifies every subagent
deliverable, and everything is documented so progress is visible step by step.

## Approaches considered

1. **Single Fable agent does everything, with a plan file.** Simplest, but violates
   requirement (2), burns Fable tokens on page reading and CSV writing, and has no
   independent check on its own work. Rejected.
2. **Claude Code orchestrator + named Sonnet subagents + local playbooks (chosen).**
   Fable runs a fixed OPAV protocol from a file, delegates each action to a role-specific
   Sonnet agent (`.claude/agents/biz-*.md`, `model: sonnet`), verifies against a per-playbook
   checklist, logs and updates PLAN.md every turn. Everything is plain files in the local
   workspace, visible in the IDE, and re-runnable with `/biz-turn`; the operational files stay
   gitignored because DATA includes PII. Uses existing Claude Code machinery (Agent tool,
   agent frontmatter `model`, skills, /loop) - no new runtime.
3. **Managed Agents / external scheduler with its own DB and queue.** More autonomy (cron,
   hosted), but a second system to operate, credentials outside the repo, and the owner could
   not watch it in the editor. Premature for a zero-revenue product; revisit if `/loop` is not
   enough.

## Design

### Components (one purpose each)
- `business/OPERATOR.md` - the orchestrator protocol: OPAV turn, priority order, strategy
  rules, worker prompt template, verification protocol, approval gates, log format, phases,
  stop conditions. `/biz-turn` loads it; nothing else defines behaviour.
- `business/AGENTS/biz-*.md` - six Sonnet workers with narrow tools: researcher (web ->
  CONTEXT docs), lead-finder (web -> leads.csv), writer (CONTEXT -> drafts), outreach (the
  only one allowed to touch channels; sends approved files only), analyst (read-only DB and
  pipeline numbers), verifier (adversarial QA, never fixes). `_worker-contract.md` holds the
  shared rules and the fixed report format every worker must return.
- `business/SKILLS/*.md` - six playbooks. Each has Procedure, Output contract and a
  Verification checklist. Worker and verifier use the same file, so "done" is defined once.
- `business/GOAL.md` - objective, done criteria per track (A self-serve subscription, B B2B
  deal), guardrails table, channels table (CONNECTED/APPROVED gate), owner decision log.
- `business/PLAN.md` - dashboard, phase status, in-progress action, next actions,
  blockers/needs-owner, decisions, product requests, turn log. Rewritten every turn.
- `business/DATA/` - leads.csv (fixed 19-column schema, stage machine), conversations/
  (one file per lead + index), outreach/ (drafts -> approved -> sent), deals/, payments.csv,
  metrics/, qa/. `business/LOGS/actions.md` append-only; `LOGS/weekly/` reviews.
- `business/install.sh` - copies AGENTS into `.claude/` (gitignored here).

### Data flow (one turn)
PLAN.md + log tail + conversations index + lead stage counts + latest metrics -> Fable
decides one action -> Sonnet worker reads its playbook + the CONTEXT files named, writes one
artifact, returns FILE/ROWS/SOURCES/KEY_FINDINGS/UNKNOWN/SELF_CHECK -> Fable reads the
artifact, runs the checklist, spot-checks reality (3+ URLs / 10% rows / every message / 2
SQL re-runs), optional biz-verifier pass -> verdict VERIFIED / REWORK (same worker, max 2) /
REJECTED -> log line + PLAN.md update -> next turn or stop.

### Verification model
Cheap workers may be wrong; the system may not. Every artifact is read by the orchestrator,
never only the summary. Checks are mechanical where possible (uniq -d on emails, column
counts, SQL re-run) and sampled where not (URLs, ICP fit). Outbound messages are read one
by one; claims must map to `CONTEXT/product.md` lines. Verdicts and their evidence are in
the log, so a reader can audit why something was accepted.

### Error handling and escalation
Worker returns nothing / pauses -> orchestrator nudges once (SendMessage), then re-dispatches.
REWORK twice -> REJECTED -> re-plan; two REJECTED on the same action -> owner. Channel tool
missing or unauthorised -> nothing is sent, stop at the gate with the question. DB
unreachable -> metrics action fails closed, logged. Strategy thresholds (reply rate < 2% per
100, positive->call < 20% per 10, signup->paid < 3% per 100, no first signal in 7 days)
trigger documented plan changes, not silent drift.

### Testing the system (how we know it works)
- Turn 1 (this session) exercised the whole loop on real work: 4 parallel Sonnet workers
  (product sheet, DB baseline, market, competitors) + 1 writer (brand voice, offer); each
  artifact verified by the orchestrator with recorded spot-checks; one worker pause was
  caught and nudged; verdicts in LOGS/actions.md.
- Mechanical checks are scriptable (CSV schema, duplicates, SQL re-run) and are the first
  thing the verifier runs.
- `/biz-turn status` gives the owner a one-screen view; PLAN.md and the append-only local logs
  show what each turn changed without placing operational data in git.

## Owner decisions (provisional defaults in GOAL.md until confirmed)
N = 10; both tracks count; no paid spend; approval above 500 USD; list prices only; 30 cold
messages per channel per day, 4 touches max; email identity and channel (none connected);
calendar/booking; Telegram/X/Reddit identities; whether the owner runs discovery calls;
do-not-contact additions; language of PLAN/LOGS (English); whether a sanitized, non-operational subset may
be tracked in git in the future.
The current decision is that operational `business/` and all DATA remain local and gitignored. Tracking a
sanitized subset is a future owner decision only: it requires an explicit `.gitignore` migration, a defined
allowlist, and a PII/credential review before any file is staged.

## Out of scope
Product, code, pricing and website changes (filed as product requests); paid acquisition;
anything sent through a channel the owner has not connected and approved.
