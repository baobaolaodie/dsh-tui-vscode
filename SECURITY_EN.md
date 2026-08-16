<div align="right">

English · [中文](SECURITY.md)

</div>

# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.5.x | ✅ |

## Reporting a Vulnerability

**Please do not disclose vulnerabilities in public issues.** Report them privately instead:

- **Recommended**: use GitHub Security Advisories (repository page → Security → Report a vulnerability) — the official private reporting channel; reporters stay anonymous and the issue stays private until fixed;
- Or contact the maintainer via GitHub (https://github.com/baobaolaodie).

The maintainer will respond within one week.

## Security Design Notes

- **No credentials in the repository**: the full history and working tree have been audited — no API keys, tokens, private keys, or credential URLs; the CI security-scan job keeps an incremental HEAD-level defense in place.
- **Keys come from the environment**: `DEEPSEEK_API_KEY` is only read from the runtime environment; neither the extension nor the TUI writes plaintext to any file.
- **Session hosting**: sessions run inside the VS Code integrated terminal; processes and signals are managed by VS Code; the extension only sends the launch command.
- **Credential-file guard**: `.env` / `*.key` / `*.pem` etc. are excluded by `.gitignore`, and CI checks tracked files for credential-like names.
