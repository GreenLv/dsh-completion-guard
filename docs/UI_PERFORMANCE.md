# Measure session switching on isolated rc.2/rc.3 frontends

This is repository operator tooling. Run these scripts from the accepted source checkout; they are not commands supplied by the npm plugin. The browser and DSH host must belong to the same disposable acceptance batch. Do not point the driver at your daily browser/profile.

Create a new fixture HOME and manifest before initializing its Web profile:

```sh
node scripts/create-ui-session-fixture.mjs --home <unused-task-home> \
  --frontend-url http://127.0.0.1:<assigned-port>/ \
  --source-commit <full-accepted-commit> --artifact-sha256 <accepted-tgz-sha256> \
  --output <new-fixture.json> --host-version 0.2.1-rc.3 \
  --prelude-turns 100 --distribution tool --output-bytes 4096
```

The producer creates a task-owned plan with two independent session IDs and unique history markers; it refuses existing HOME/output paths. It deliberately leaves session creation to the loaded host. `prelude-turns` accepts 0–10000; `distribution roots` creates independent root requests, while `distribution tool` adds three synthetic tool round trips per prelude turn with one output of `output-bytes` (0–1048576). These are persisted frames; no command is executed. The final marker adds one turn. Each completed history records actual event count, serialized event bytes, root input count/density and tool-result count. Preserve the manifest and producer hash.
The versioned preparation entrypoint installs the supplied canonical tgz through the official managed CLI, checks its embedded source/version, runs inspect → inject → dump → verify-dump from the installed Guard, and can keep the isolated Web host running:

```sh
node scripts/prepare-ui-session-fixture.mjs --fixture <fixture.json> \
  --runtime-root <managed-runtime-root> --artifact <accepted.tgz> \
  --artifact-record <release-artifact.json> --output <new-preflight.json> --preflight
node scripts/prepare-ui-session-fixture.mjs --fixture <fixture.json> \
  --runtime-root <managed-runtime-root> --artifact <accepted.tgz> \
  --artifact-record <release-artifact.json> --output <new-preparation.json> --serve
```

Use distinct new result paths. Preflight reads the canonical artifact identity and probes a child in that invocation; it does not install or start a host. The actual run uses this fixture's `DSH_HOME/sessions` and `profiles/web`, strips ambient credential environment layers, disables telemetry/background Goal driving, and points the inert model route at a closed loopback endpoint. It does not send a model request. After Guard loads, the fixture plugin uses the official AgentRegistry to create both sessions, requires actual `fresh_creation` / `always` bindings and the registered Guard tool, writes history, flushes, disposes the seed agents, and reopens each official persistence reader to verify its ID and marker. It exports `<new-preparation.json>.protected-fixture.json`. The `.ready.json` records these checks; the driver still verifies rendered identities and the live agent after official UI promotion through the task-owned read-only observer. A missing or inactive Guard fails the run rather than measuring a mode-unknown path. Preserve the private host log. Signal the preparation process after measurement; it stops only its owned process tree, reports cleanup failure, and preserves the HOME/results. This preparation record does not replace the repository's native-acceptance/v2 install/no-op/parity/lifecycle annex.

Start a task-owned browser with an explicit loopback CDP endpoint through the native platform's supported launcher. Do not disable its sandbox. The browser owner retains its PID/profile and stops it after measurement. These startup/installation operations remain native steps and do not become passing facts because fixture creation succeeded. Never reuse a daily host, hard-code its port, repack the artifact, or send messages to seed markers.

Then run:

```sh
node scripts/measure-session-switch.mjs --fixture <new-preparation.json>.protected-fixture.json \
  --cdp-url http://127.0.0.1:<browser-debug-port>/ \
  --output <new-measurement.json> --switches 100
```

The driver creates one browser tab and closes it on success, failure or handled interruption. It never starts or stops the browser/DSH host. It clicks the official session tree rows (`data-row-key`, `aria-selected`), reads visible history inside `data-chat-flow`, waits for the reviewed loading hint to disappear, and inserts a probe through browser input events into the official `data-composer-input` editor. The fixture must have empty drafts; the probe is removed and the empty draft read back before a sample is accepted. Overall interactivity ends at successful input readback; draft cleanup time is recorded separately. Loading appearance/disappearance and observed duration are separate fields, or null when no indicator appeared. No Enter/send action occurs. The other history's unique marker is a negative control. A missing session row must be refused without changing the active session. Unknown layouts/identity, load errors, unobservable input, failed controls, timeouts and too few samples fail nonzero. Failed runs retain a result; they are not timing passes.

The public attributes and loading/error classes are bound to the reviewed rc.2 and rc.3 workspace, chat and conversation frontend components. Their relevant DOM components/selectors were compared before sharing this adapter; other versions are refused. An unknown new layout requires an explicit adapter review, not a guessed successful field. Protocol/control unit tests are not rendered frontend or native evidence: a real browser smoke run is still required for each applicable host.

For formal performance acceptance, retain the agreed same-host baseline/candidate inputs, fixed A/A noise, paired/interleaved order, at least 30 cold and 100 warm samples per required cell, P50/P95, one-sided 95% bounds, lifecycle/RSS checks, and actual history scales. `--switches` only collects one warm tab's sequence; it does not label samples cold or run those statistical gates. The native owner must stop its own host/browser before removing the owned HOME and report cleanup separately. Desktop GUI acceptance requires its supported isolated carrier/CDP route; a Web result does not certify Desktop.

For the 0.11.0 comparison, use isolated rc.2 hosts for the paired 0.10.0/candidate regression cells: the public 0.10.0 baseline does not qualify rc.3 Desktop. Run rc.3 GUI, latency and lifecycle acceptance separately and retain that missing valid baseline boundary. Do not weaken baseline admission, downgrade daily hosts, or call the separate rc.3 timings a paired regression pass.

The driver also exports `initialOpen`, separate from its warm sequence: the first click's epoch, click-to-input-readback time, input completion epoch, loading observations and whether that target was already live before selection. It never labels this record cold. For a cold run, create and persist the fixture in a separate seed process, stop that process, and start a new observer-only host. Require `initialOpen.preClickTargetLive === false` and the outer launcher's fresh-process evidence; use the recorded completion epoch with the launch epoch for startup-inclusive timing. Do not seed, append, promote, or read the target's full history in that cold process before the GUI opens it.

For Web, reuse the original plan and exact seed receipt in a new preparation run:

```sh
node scripts/prepare-ui-session-fixture.mjs --fixture <original-plan.json> \
  --runtime-root <managed-runtime-root> --artifact <accepted.tgz> \
  --artifact-record <release-artifact.json> --output <new-observer-run.json> \
  --mode observe --seed-fixture <seed-preparation.json>.protected-fixture.json \
  --seed-sha256 <sha256-of-that-protected-fixture> --serve
```

This mode skips installation and injection, rechecks the installed identity, and supplies the probe's explicit `mode: observe`. The probe verifies nonce, source/artifact, HOME/profile, host version, producer/probe bytes and existing fresh-creation bindings; it refuses already-live fixture agents. It registers only the read-only live observer, without creating, appending, promoting or reading either session history. It writes a new observer-ready receipt and preserves the seed receipt. Unknown modes and changed/missing identities or bindings fail closed. Actual process isolation, cold state and restoration remain native observations.

For Desktop, create the plan with `--surface desktop --frontend-url dsh-app://app/`. The Web preparation command does not prepare or launch Desktop. The native acceptance owner supplies a qualified isolated Desktop profile with the same frozen artifact, `activation: always`, and the `scripts/ui-session-host-fixture.mjs` plugin. Its config binds `fixturePath`, `runtimeRoot` (`app.asar/dsh`), the installed injected `guardConfig`, and a new `output` seed receipt. After the separate seed process stops, use explicit `mode: observe`, that same `output`, `seedReceiptSha256`, and a distinct new `runOutput`. The probe checks the physical Desktop carrier lock separately from its SDK namespace. The existing versioned Desktop install/no-op/lock workflow remains the preparation contract; a handwritten profile or fabricated anchors are not equivalent.

The native launcher must use a task-owned `DSH_HOME`, a new `<fixture-home>/desktop-user-data`, the official signed executable and a dedicated loopback CDP endpoint. It must bind actual process ownership and the main renderer before writing a `dsh-ui-desktop-owner/v1` receipt with `fixtureNonce`, `sourceCommit`, `hostVersion`, absolute `home` and `userDataDir`, exact `cdpUrl`, `rendererUrl: "dsh-app://app/"`, `targetId`, `processId` and `carrierSha256`. Keep that native launch evidence with the receipt. The driver validates the receipt's identity fields; it does not claim those declarations independently prove the launcher/process arguments.

```sh
node scripts/measure-session-switch.mjs --fixture <desktop-protected-fixture.json> \
  --cdp-url http://127.0.0.1:<owned-desktop-debug-port> \
  --desktop-ownership <native-owner-receipt.json> \
  --output <new-desktop-measurement.json> --switches 100
```

The Desktop driver attaches only to that existing `dsh-app://app/` main renderer, verifies its exact URL and detaches afterwards. It never creates or closes a Desktop window. A new file tab cannot use the application's main-frame IPC and is refused. Custom-protocol URLs are compared explicitly; their `null` URL origins are never treated as equal. The task-owned live observer uses the application's actual protocol handler to reach its registered read-only backend route. The native owner handles any welcome-screen transition through the official UI, verifies that fixture targets were not preopened, and stops only its isolated process tree after measurement. Unit transport controls establish neither a rendered Desktop pass nor native cleanup.
