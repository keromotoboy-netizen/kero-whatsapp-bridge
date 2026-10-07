# Security Policy

## Private reporting

Do not publish credentials, tokens, customer data, WhatsApp session material, internal URLs, or exploitation details in public issues.

Report security findings privately to the repository owner. Rotate any exposed credential before discussing the incident publicly.

## Repository rules

- No secrets or customer data in Git history.
- Prefer OIDC or short-lived credentials.
- GitHub Actions use least-privilege permissions.
- Third-party Actions are pinned to a full commit SHA.
- Public runners process only data safe for a public repository.
- Production secrets must stay outside the repository.
