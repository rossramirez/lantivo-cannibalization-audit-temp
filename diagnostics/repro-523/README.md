# Lantivo — targeted reproducibility probe for 523 cross-run members

Diagnostic-only branch. No production writes, no score/policy changes.

Base audit commit: f2f3e63e73553e1e1a67e977c2f796facc6701b6

Purpose: isolate why identical frozen inputs produced 523 -> 0 context delta across two runs, without re-running the full national gate.
