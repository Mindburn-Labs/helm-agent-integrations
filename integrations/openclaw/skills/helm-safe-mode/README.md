# OpenClaw HELM Safe Mode

Optional skill wrapper for OpenClaw-style agents.

Behavior:

- classify skills by side-effect capability
- submit high-risk calls to HELM before dispatch
- escalate external sends, calendar changes, purchases, check-ins, and
  credential reads
- deny credential egress, unknown network egress, and unapproved shell execution
- return HELM decision and receipt metadata with the skill result
