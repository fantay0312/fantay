# Fantay workspace

- The Git root is this directory. The private repository is `fantay0312/fantay`, with `main` as the default branch.
- Application packages and their detailed engineering guidance live in `studio/`. Read `studio/AGENTS.md` before editing application code.
- Use the root `mise.toml` tasks or run commands through mise inside `studio/`.
- Maintain Fantay from its own product requirements, source repository, release metadata, and CDN. Review external source imports as individually scoped changes.
- Current setup and maintenance instructions are in `studio/README.md`, `studio/CONTRIBUTING.md`, and `studio/MAINTAINERS.md`.
- Preserve original licenses, author attribution, historical issue references, and compatibility identifiers when maintaining inherited code.
- Validate affected behavior with focused tests. Keep runtime data, credentials, local libraries, and build output covered by the existing ignore rules.
