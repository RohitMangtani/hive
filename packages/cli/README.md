# @rohitmangtani/hive

CLI installer and runtime helper for Hive.

Not yet published to npm (publication is planned), so run it through the repo's local wrapper. Clone [github.com/RohitMangtani/hive](https://github.com/RohitMangtani/hive) first, or use `bash scripts/install.sh --fresh` for the full install flow.

## Usage

From a clone of the repo:

```bash
npm run hive -- init
npm run hive -- init --fresh
npm run hive -- init --desktop
npm run hive -- init --connect wss://URL TOKEN
npm run hive -- doctor
```

By default, `init` clones Hive into `~/hive` if a local repo is not already available. Use `--dir /path/to/hive` to override the install location.
