# Repository Guidelines

## Project Structure & Module Organization

This is a WXT-based Chrome/Edge Manifest V3 extension. `entrypoints/` contains the background, content, popup, options, side panel, and workbench entry points. Shared code lives in `src/`: `core/` is the browser-independent TypeScript redaction engine, `content/` handles paste interception and site adapters, `storage/` wraps local extension storage, `ui/` contains shared React components, and `i18n/` holds Chinese UI text. Unit tests are in `tests/`; browser extension E2E tests and fixtures are in `e2e/`. Static extension icons are under `public/icon/` and other source artwork under `assets/`.

## Build, Test, and Development Commands

- `npm install` installs dependencies and prepares WXT types.
- `npm run dev` starts the local extension development server.
- `npm run build` builds the extension into `.output/chrome-mv3`; `npm run zip` packages it.
- `npm run compile` runs TypeScript checks; `npm run lint` runs ESLint.
- `npm test` runs Vitest unit tests; `npm run test:watch` runs them interactively.
- `npm run e2e` runs Playwright tests. Build first and install its Chromium with `npx playwright install chromium`; E2E needs a graphical session (use `xvfb-run` in CI).

## Coding Style & Naming Conventions

Use TypeScript and React conventions already present in the surrounding module. Prettier is configured for two-space indentation, single quotes, semicolons, trailing commas, and a 100-character print width. Run `npm run format:check` before submitting; use `npm run lint` for linting. Name Vitest files `*.test.ts` and Playwright specs `*.spec.ts`.

## Testing Guidelines

Keep core behavior covered by focused Vitest tests under `tests/`; the Vitest environment is Node because the core engine does not depend on browser APIs. Add or update Playwright coverage in `e2e/tests/` for extension UI, browser integration, and paste interception. Run relevant tests plus `npm run compile` and `npm run lint` for code changes.

## Commit & Pull Request Guidelines

Recent commits follow `type(scope): summary`, such as `fix(content): ...`, `feat(ui): ...`, or `chore(release): ...`; release commits may include a version. Keep summaries concise and describe the user-visible change. PRs should explain the behavior and rationale, link related issues when available, and list validation commands and results. Include screenshots for visible UI changes and steps to reproduce bug fixes.

## Security & Configuration

VESPER processes text locally. Preserve this privacy model: do not add network transmission, analytics, cookie access, or `chrome.storage.sync`. Keep host access optional and request site permissions only through the existing site configuration flow.
