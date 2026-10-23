# PingRoom job control

Let a trusted teammate pause, resume, or cancel the remaining units of an initialized local batch from PingRoom. The runner reads controls at each checkpoint, performs at most one unit, and saves its result. Completed work remains available after cancellation.

The sample job uppercases supplied text and records its SHA-256 digest locally. It runs no shell commands, signals no processes, and makes no deployments. Pause and Cancel affect future units; they cannot interrupt a unit already executing. This is cooperative control, not a safety shutdown system.

## Try it offline

Requires Node.js 22 or newer on macOS or Linux, with persistent private storage. Choose **Use this template**, clone your repository, then run:

```sh
npm ci
npm run demo
npm test
```

The demo uses the pinned SDK with an in-memory HTTP transport. It resumes one unit, pauses, resumes another, and cancels the remaining work. A later Resume cannot undo cancellation. It needs no credentials or network after installation and deletes its temporary files.

## Connect and configure

1. Install [PingRoom](https://pingroom.io/i). The connecting account and a trusted controller must share a **dedicated standard private room**. Use one active job and one runner for that room.
2. In the app, configure three plain action slots labeled exactly **Pause**, **Resume**, and **Cancel**, with no required input. This starter reads existing actions and never configures or presses them.
3. Run `npm run connect`, approve its printed link, and select the shared room. Grant notification-read and room-read access: `pingroom:notifications:read` and `pingroom:rooms:read`, plus access to that room.
4. Have the controller press the harmless Pause action, then run `npm run inspect`. Match their tap to its exact sender UUID. Inspection shows at most 25 recent feed records; run it promptly. Names alone do not establish identity.
5. Copy and edit the examples:

```sh
cp config.example.json config.json
cp examples/job.json job.json
```

Set the three action slot numbers and the controller UUIDs in `config.json`. Replace the example run ID and items in `job.json`. The sample supports 1–50 distinct item IDs, each with 1–1000 printable ASCII text characters. Run and item IDs use 1–64 letters, digits, underscores, or hyphens, starting with a letter or digit. Configuration supports 1–5 controllers and slots 1–16.

**The wait feed excludes the connecting account's own pings.** Use a different trusted room member as controller. Do not add the connecting account to the controller list. The runner cannot infer that account's identity from the feed or detect its missing taps.

Pairing saves ignored `.pingroom/credentials.json` with private permissions. An interrupted pairing reuses its saved link. An existing connection is never overwritten. After confirming a saved link has expired, remove only `.pingroom/pairing.json` before reconnecting.

Before registration, setup saves a private creation intent in `.pingroom/pairing.json`. A crash or lost response before the pairing details are saved leaves an uncertain outcome; running `connect` again refuses another registration. Keep that file and inspect Connected Agents. Resolve or revoke any created robot before archiving the file for an intentional new setup. This requires manual investigation and does not guarantee exactly-once robot creation. If a crash leaves `.pingroom/.lock`, confirm the setup process stopped before removing only that lock.

For an existing connection, set both `PINGROOM_TOKEN` and `PINGROOM_ROOM` in the shell or `.env`. Shell values take precedence; a complete environment pair overrides saved credentials, while blank or partial pairs fail. `.env.example` contains commented placeholders. Configuration, credentials, and state paths resolve from this project directory.

## Initialize and run checkpoints

```sh
npm run init
```

Initialization validates the room and action identities, captures the current feed head, and saves a **paused** run. Earlier taps, including setup taps, are skipped. Repeating `init` returns the existing run without resetting it. Wait for initialization to finish, then have the controller press Resume.

```sh
npm start
npm run status
```

`start` performs one checkpoint and exits. It reads room membership and action configuration, consumes up to five batches of 50 visible feed events, then performs at most one unit if the last applicable control leaves the run running. Run it again for another unit, or invoke it periodically from your existing scheduler. Serialize invocations; no scheduler is installed.

- Pause prevents the next unit from starting. Resume continues with the first unfinished unit.
- Cancel is terminal. Later controls cannot restart the run, and completed results are preserved.
- A completed run is also terminal. `status` reads the saved report locally without credentials or API calls.
- If all five batches are full, `deferred: "control_backlog"` is returned and no unit runs. The next checkpoint continues draining from the saved cursor.

Controls are applied in server cursor order. Only the configured room, exact trusted sender UUIDs, and configured action slots qualify. Events must explicitly be manual human pings, without an originating agent, question, or handoff. Message text, attachments, URLs, and structured data are never executed or interpreted as commands.

There is a gap between reading controls and completing a unit. A tap arriving during that gap applies at a later checkpoint. Visibility changes, deleted events, server retention, and downtime can also affect what the connection observes; the report does not claim complete feed history. Keep the room dedicated and controller access stable. Do not use this mechanism for work that requires guaranteed or immediate interruption.

## Restart and recovery

The private `.job/state.json` binds the immutable job, controller policy, credential fingerprint, room UUID, and action identities. Changes to those inputs stop an active run. Action labels and required-input settings are checked before consuming controls. Keep their meaning unchanged for the run.

Each batch's controls and cursor are committed together before work. A unit's result is committed in a later atomic write. If work or its result write fails, the same unit may run again; the shipped transformation is pure and safe to repeat. A checkpoint never deliberately records a unit as complete before saving its result. Do not substitute non-idempotent external actions without designing their own durable execution and recovery protocol.

Repeated, backwards, malformed, or inconsistent feed batches stop work. Read failures preserve committed state. Corrupt state must be restored from a valid backup; deleting it resets the run boundary and is not recovery. After a crash, inspect `.job/.lock/owner.json`, confirm the process has stopped, and remove only the lock if necessary. All writers must honor the lock; this is local persistence, not distributed coordination.

To start a different job, first finish or cancel this run and stop its scheduler. Archive the whole `.job/` directory privately, update the manifest with a new run ID, and initialize again. Keep controllers quiet during that transition. An old run's late tap carries no job ID and could otherwise control the new run in the same room.

## Adapt and verify

Import `runCheckpoint` from `src/engine.js` for a scheduled worker. `transformItem` in `src/model.js` defines the sample unit and validates saved outputs. Adapt both the transformation and its output validation together. Keep units bounded and repeatable, and preserve the checkpoint and terminal-state rules.

History is capped at 500 accepted controls; reaching the limit stops further work without discarding its cursor. State is capped at 512 KiB, job input at 64 KiB, and configuration at 16 KiB. Each HTTP request, including its response body, has a five-second deadline and a 512 KiB response limit; a normal checkpoint makes at most seven requests. Redirects are refused. Directories use `0700` and files `0600`; credentials, manifests, and state are ignored by Git. Keep backups private.

Exit codes are `0` for complete work and local commands, `2` for cancelled work, `3` for paused/running/backlog states (including initialization), `1` for failures, and `130` for interruption. A scheduler should treat `3` as an unfinished run, not a completed batch.

SDK `0.6.0` is pinned with a lockfile and a 14-day minimum release age. CI runs the offline tests and demo on Node 22 and 24. Live phone delivery and teammate control were not tested.

Unlike [room action runner](https://github.com/pingroom/starter-room-action-runner), where each tap starts an independent task, this starter controls remaining work in one persistent job. [Job progress](https://github.com/pingroom/starter-job-progress) reports execution progress; this starter changes whether the next unit may execute.

[Official SDK](https://github.com/pingroom/sdk) · [MIT license](LICENSE)
