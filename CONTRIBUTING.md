# Contributing to Hive

Thanks for your interest in contributing. Hive is a process-level orchestration layer for AI agent fleets  --  it discovers running AI CLI agents, shows their status on a real-time dashboard, and coordinates them across machines.

## Getting Started

```bash
git clone https://github.com/RohitMangtani/hive.git
cd hive
npm install
```

### Requirements

- **macOS**, **Windows**, or **Linux with tmux**. The Linux platform layer (process discovery, terminal I/O, window management) is fully implemented and wired through the daemon; what remains is live-host testing across more Linux distributions and desktop environments, not the platform code itself. Windows needs Git Bash with python3 visible from bash, and has a different interaction model: messages are delivered via hooks on the agent's next prompt or tool call, and prompt approval happens at the terminal (no dashboard keystroke delivery).
- **Node.js 20+**
- At least one AI CLI: `claude`, `codex`, or `openclaw`

### Running locally

```bash
# Start the daemon (port 3001 HTTP, port 3002 WebSocket)
npm run dev:daemon

# In another terminal, start the dashboard (port 3000)
npm run dev:dashboard
```

Open Terminal.app windows and run `claude` or `codex`  --  they appear on the dashboard within 3 seconds.

### Running tests

```bash
cd apps/daemon
npm test              # run all tests
npx vitest run        # same thing
npx vitest --watch    # watch mode
```

Tests require no external services. The status detection tests create temporary JSONL files. The API route and WebSocket server tests start a local HTTP server on a random port, so they need the ability to bind `127.0.0.1`; in network-sandboxed environments they fail with `listen EPERM` only, which is environmental, not a code problem.

The API route tests also assert intended security behavior: privileged REST routes (spawn/kill/exec/satellites/repair) return 403 before input validation for non-admin users, and the tests check that ordering on purpose.

### Type checking

```bash
cd apps/daemon
npx tsc --noEmit                          # daemon source
npx tsc -p tsconfig.test.json --noEmit    # tests
```

The main `apps/daemon/tsconfig.json` intentionally excludes `src/__tests__` because it doubles as the build (dist emit) config. Never add tests to its include; test typechecking is the separate `tsconfig.test.json` command above.

### CI

CI runs, in order: daemon typecheck, daemon test typecheck, dashboard typecheck, shell-script lint (`bash -n` over `scripts/`, `apps/daemon/scripts/`, and `apps/daemon/src/hooks/`, plus `node --check packages/cli/bin/hive.js`), daemon build, dashboard build, then daemon tests. Builds run before tests so build breakage is surfaced even while a test is red.

## Project Structure

```
hive/
├── apps/
│   ├── daemon/          # Node.js daemon (Express + WebSocket)
│   │   ├── src/
│   │   │   ├── index.ts           # Entry point, tick loop
│   │   │   ├── telemetry.ts       # Worker state, hooks, dispatch
│   │   │   ├── discovery.ts       # Process scanning, status detection
│   │   │   ├── tty-input.ts       # Terminal I/O (AppleScript + CGEvent)
│   │   │   ├── auto-pilot.ts      # Auto-respond to stuck prompts
│   │   │   ├── ws-server.ts       # WebSocket + satellite federation
│   │   │   ├── review-manager.ts  # Auto-detect git push/PR/deploy
│   │   │   ├── coordination.ts    # Scratchpad, locks, artifacts
│   │   │   ├── swarm-controller.ts # Cross-machine spawn/kill/exec
│   │   │   ├── user-registry.ts   # Multiplayer: named users, roles, tokens
│   │   │   ├── platform/          # Cross-platform abstraction
│   │   │   │   ├── interfaces.ts  # TerminalIO, ProcessDiscoverer, WindowManager
│   │   │   │   ├── linux/         # tmux-based implementation
│   │   │   │   └── macos/         # Wrapper over existing macOS code
│   │   │   └── ...
│   │   └── src/__tests__/         # Test files (150+ tests)
│   ├── dashboard/       # Next.js dashboard (static export)
│   └── desktop/         # Tauri desktop wrapper
├── packages/
│   ├── cli/             # Local `hive` CLI wrapper for init/doctor flows
│   └── types/           # Shared TypeScript types
├── scripts/             # Install, deploy, recording scripts
└── docs/                # Architecture docs, diagrams, demo
```

See [docs/architecture.md](docs/architecture.md) for a detailed data flow explanation.

## How to Contribute

### Good first issues

- Add tests for `session-stream.ts` (JSONL parsing for different agent formats)
- Improve error messages in the REST API (some return raw error strings)

### Bigger contributions

- **Live-test the Linux/tmux runtime on more hosts**  --  The platform layer (discovery, terminal I/O, window management, quadrant detection) is complete. What is needed is live testing across different Linux distributions (Debian, Fedora, Arch), desktop environments, and tmux versions to catch edge cases in pane layout detection, TTY path formats, and process tree differences.
- **Publish the CLI/init flow**  --  `packages/cli` now owns the local `hive init` and `hive doctor` entry points. The next step is turning that into a polished npm install surface with a final package name.
- **Agent plugin system**  --  Let users add new agent types via config files
- **VS Code extension**  --  Show fleet status in the status bar using the REST/WebSocket API

### Pull request guidelines

1. Fork the repo and create a branch from `main`
2. Run `npx tsc --noEmit` and `npx tsc -p tsconfig.test.json --noEmit` in `apps/daemon`  --  must compile clean
3. Run `npx vitest run` in `apps/daemon`  --  all tests must pass
4. Keep commits focused  --  one logical change per commit
5. Write a clear PR description explaining what and why

### Code style

- TypeScript strict mode
- ESM imports (`.js` extensions in import paths)
- No external linter enforced  --  match the existing style
- Tests use vitest
- Prefer small, focused modules over large files

## Architecture Decisions

Some patterns in the codebase are intentional and should not be changed without discussion:

- **TTY input two-step approach** (`do script` + `send-return`): This is the only method that reliably sends text + Enter to Terminal.app from a background process. See `tty-input.ts` header comments.
- **Status detection layering**: The phantom-green prevention pipeline in `discovery.ts` has seven cooperating JSONL/hook layers plus a CPU/PTY corroboration signal. Removing any one creates a distinct failure mode. See `docs/architecture.md`.
- **3-second tick loop**: The daemon polls every 3 seconds. This is a deliberate choice  --  event-driven alternatives were considered but the tick approach is simpler and reliable for process-level detection.

## Questions?

Open an issue on GitHub. For architecture questions, tag it with `question`.
