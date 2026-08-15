# Changelog

## 0.1.0 (2026)

- Initial MVP (issue ccch1mneyyy/dsh-TUI#161, Path A):
  - start / resume / focus / terminate `dsh-tui` sessions in the integrated terminal;
  - clickable file paths in terminal output (`path:line[:col]`, ANSI-aware, CJK punctuation aware);
  - `$VISUAL`/`$EDITOR` injection via `code -w`; optional `$DSH_HOME` override;
  - configurable command, extra args, terminal name and `DSH_TUI_LANG`;
  - status-bar item; per-terminal env injection; terminal link provider scoped to owned terminals;
  - session adoption on extension reload (no duplicate terminals after reload);
  - Windows launch via `cmd.exe /d /s /c` (quoting verified against real cmd.exe);
  - CI: typecheck + unit tests + vsix packaging on GitHub Actions.