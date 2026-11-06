# Kiraya Register — build plan (completion note)

## v1 built 2026-11-06/07 — all six phases complete, final test count 455/455

- **Phase 1 — auth + roles + isolation:** users + sessions, scrypt, cookies, lockout, register/login/logout/me/change-password, master suspend + password reset, ADMIN_CODE fail-closed, security headers, XSS escaping.
- **Phase 2 — houses + link codes + tenancy approval:** houses CRUD (owner-scoped), code generation/regeneration, tenant link request, owner approve/reject with reason, tenancy record (rent/due day/agreement dates + ticks). Nothing exists before approval.
- **Phase 3 — schedules + bills + notifications:** owner-kept schedules (rent + gas + electricity + others), lazy monthly bill generation, variable-amount entry, in-app bell + notifications list + WhatsApp share links.
- **Phase 4 — payment proofs + receipts:** proof upload (magic bytes + 5 MB + 1 current proof per bill), owner approve/reject with reason, bill → paid, receipt (`RCP-<tenancy>-<seq>`), tenant re-upload after reject, ledger + CSV export.
- **Phase 5 — WhatsApp-like chat:** messages table, per-tenancy threads, bubbles + ticks + timestamps + photo messages, polling (5s chat / 15s thread list), read receipts, thread list with unread counts.
- **Phase 6 — final review (2026-11-07):** full security-checklist re-verification with evidence per box; fixed the tick-semantics gap (thread-list fetch now marks delivered only, opening the thread marks read — sent → delivered → read is observable); P2/scope check (nothing from the closed list leaked in); honest limits verified printed in-app; one full end-to-end scenario test; CSRF tests and the ADMIN_CODE fail-closed spawn test added; README written; final suite **455/455 green twice in a row** + fresh smoke on port 3038.

Source plan: `~/workspace/new-projects/p11-rent-flow-plan.md`.
Source research: `~/workspace/new-projects/p11-rent-flow-research.md`.

Still unverified: the real-browser pass on Hashir's PC (owner creates a house → tenant links → schedule → bill → proof → approve → chat). No live date until a container slot frees (SnapDeploy 4/4 full); the app runs on his PC on port 3038 meanwhile.
