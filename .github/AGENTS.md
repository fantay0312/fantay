# Fantay GitHub configuration

- The repository root is the parent of this directory. Application commands run in `studio/` through mise.
- The default branch is `main`, and the repository is `fantay0312/fantay`.
- Keep workflows self-contained and use the checked-in runtime versions from `studio/mise.toml`.
- The validation workflow is manually triggered and runs the repository guard and workspace typecheck.
- Keep validation permissions read-only. Publishing workflows and credentials require an explicit task.
- Use the root pull request template and preserve licenses and third-party notices.
