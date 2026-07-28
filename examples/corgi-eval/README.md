# Corgi Eval

An eval of how well an AI model and OpenLedger fit with each other. Each
run hands a model the OpenLedger skill, a sandbox of its own and a password-protected card
statement, then reports what the pair got done and where they misread each other.

## Run it

```sh
cd examples/corgi-eval
cp .env.example .env      # point LLM_BASE_URL and LLM_MODEL at your endpoint
npm install
npm start
```

Needs Node 18 or newer, `npm run build` at the repo root (the sandbox installs the
packed tarball), and network for that install.

A statement reaches the model as extracted text, or as page images when the
harness has no text to give. A model that accepts neither is stopped at startup
rather than left to write a report of zero rows. On OpenRouter both the input
types and the model's context window are read from the model list; on any other
endpoint set `LLM_INPUT_MODALITIES`.

`.env`: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_STREAM`, `LLM_TIMEOUT_MS`,
`LLM_INPUT_MODALITIES`, `CONTEXT_BUDGET_TOKENS`. Flags: `--model`, `--base-url`,
`--keep` (keep the sandbox), `-h`.

Each run prints a summary and writes `reports/<date>-<model>.md` and `.json`.
`npm run typecheck` and `npm test` check the harness itself without an endpoint;
`npm test` needs Node 21 or newer, whose test runner expands the glob it passes.

## What the host carries

The model has one tool, `oled`, and no way to open a file. So when a command
reports having produced something to read, the host puts it into the conversation:
the extracted document as a text part, page images for a model that accepts
images, nothing at all for a model that accepts neither. Everything the host
attaches, cuts to stay inside its size caps, or has no route for is counted in
the report.

This is transport, not help. The model chooses the command; the host only hands
back what that command produced, byte for byte. It never opens, parses, or
summarizes a statement, and it never writes to the ledger. Claude Code does the
same job with `Read` in `examples/corgi-claude`; `oled ingest --help` is what
tells an agent to read what `ingest prepare` returns. Coaching would be extracting
rows for the model or naming the flag it should run; neither happens, and a run can
still fail.

If neither route applies, nothing is attached and the model has to degrade on its
own. Whether it does is part of what the eval measures.

## Findings so far

Two of these drove CLI fixes, now shipped. The third is what the eval still
watches for.

- Models invented `--format text` to ask for text they could read. Fixed at the
  source: `ingest prepare` now extracts the text itself and returns it whenever it
  can, and the format flags it was guessing at are gone.
- `skills/SKILL.md` step 5 told an agent to stage its batch to a file, which an
  agent with no file writes cannot do. Fixed: standard input takes a batch, and
  `ingest commit --help` and the empty-batch hint both say so.
- Three runs scored zero rows because the harness handed nothing back, and it took
  reading all three reports to see it. Section 6 of every report now names what
  the model reached for and never got, where it said it was stuck, and how far the
  ledger had moved by the end of each phase.
