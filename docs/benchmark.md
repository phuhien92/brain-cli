# Benchmark: grep vs. the Obsidian CLI vs. brain

The README claims ranked search beats an agent's grep loop. `brain bench` turns that into
numbers: it runs every question in a question file three ways and reports, per question and
in total,

- **Found** — did the expected note come back first (top 1), or in the first five (top 5)?
- **Tokens read** — bytes the method put in front of the agent, divided by four.
- **Calls** — how many commands it took.

No model is in the loop. The same vault and questions give the same counts on any machine;
only the timings (`ms`) vary.

## Run it

`brain bench` is a [command extension](extensions.md) in [`examples/bench/`](../examples/bench/).

```sh
brain ext install ./examples/bench      # approve in a terminal; read: whole vault, write: nothing
brain bench questions.jsonl             # table on stderr, the brain.v1 envelope on stdout
brain bench questions.jsonl --json      # envelope only
```

To rerun the public demo, copy it first, because enabling the extension writes a note into the vault:

```sh
cp -R examples/bench/demo /tmp/brain-demo
brain ext install ./examples/bench --vault /tmp/brain-demo
brain bench questions.jsonl --vault /tmp/brain-demo
```

Each line of the question file is one question and the note that answers it:

```json
{"id": "dentist", "question": "when is my next dental cleaning", "expect": "People/Dr Patel.md"}
```

`expect` may be a list when more than one note is a right answer. A relative path is read
from the vault root, an absolute path from anywhere, and `-` reads stdin. `--methods grep,brain`
runs a subset.

Installing enables the extension by writing a note under the vault's log folder. To
benchmark a vault without writing anything into it, run the script directly; it uses the
`brain` in the same checkout or package:

```sh
node examples/bench/bin/brain-bench /path/outside/the/vault/questions.jsonl --vault ~/vault
```

A command extension is stopped after 30 seconds. A run makes three `brain` calls per question,
so `brain bench` suits a few dozen questions. Run larger sets with the script directly, which has
no time limit.

## The three methods

Each method models what an agent does, the same way for every question.

1. **grep.** Take the question's words without stop words, and keep those of three letters
   or more. Start with the longest. `grep -rilF --include=*.md` it over the vault
   (dot-folders and `node_modules` skipped, like brain). While more than five files match,
   narrow the list with the next word (`xargs grep -il`), skipping a word that would leave
   nothing. At most four words. Then read the files in the order grep listed them, at most
   five. The agent is assumed to recognise the answer the moment it reads it, so reading
   stops at the expected note. That is generous to grep: a real agent cannot know when to
   stop. Calls: every grep round and every file read. Tokens: grep's output plus every file read.
2. **Obsidian CLI** (1.12+, with the app running). `obsidian vault=<name> search
   query=<words joined by OR> limit=5 format=json`, then `obsidian read` on the top result.
   Obsidian's search ANDs words, so the bench ORs them, the way brain treats a question.
   When `obsidian` is not on `PATH`, or does not answer, the method is skipped and says so on stderr.
3. **brain**, as the [skill](../skills/brain/SKILL.md) teaches: `brain search "<question>"
   --json --limit 5`, then `brain get <top hit> --meta --json` for its headings, then
   `brain get <top hit> --section <heading> --json` for the heading sharing the most words
   with the question (the whole note when none does). Always three calls. Tokens count the
   whole JSON envelope except its `vault` path and `index` timings, which depend on the
   machine and the moment, not on the question.

Found is the expected note's position in the list the method ranked: grep's file order,
Obsidian's results, brain's results.

## Rules

- **The question file is never an answer.** brain indexes only `.md` files, grep is
  restricted to `*.md` and told to skip the question file, and a `.md` question file inside
  the vault is refused.
- **A question set built from a private vault stays private.** Publish only aggregate
  numbers, as below. The public demo vault and its questions are in
  [`examples/bench/demo/`](../examples/bench/demo/) for anyone to rerun.
- **Deterministic.** No model, no network. CI runs `brain bench` against the demo vault on
  every push and checks that two runs give identical counts.

## Results

### Demo vault (public)

18 short notes and 14 questions ([`examples/bench/demo/`](../examples/bench/demo/)).
The Obsidian CLI was not installed.

| Method | Top 1 | Top 5 | Tokens read | Calls |
| --- | --- | --- | --- | --- |
| grep | 9 / 14 | 14 / 14 | 3,224 | 36 |
| Obsidian CLI | skipped | | | |
| brain | **14 / 14** | 14 / 14 | 7,811 | 42 |

On a vault this small, grep's lists are short and every note is under 2 KB, so reading whole
files is cheap. brain gets the answer first every time but reads more: its JSON carries
metadata (frontmatter, tags, links), and it spends a call listing headings. The demo shows
the method works. The private vault below is a fairer test of the claim.

### A real vault (private)

The maintainer's working vault: 138 notes, about 2.5 MB of markdown, several of them over
100 KB. 33 questions written the way they would be asked, each with the one note that
answers it. The questions and per-question
results stay private; these are the totals.

| Method | Top 1 | Top 5 | Tokens read | Calls |
| --- | --- | --- | --- | --- |
| grep | 6 / 33 | 18 / 33 | 1,639,426 | 188 |
| Obsidian CLI | skipped (CLI not enabled) | | | |
| brain | **23 / 33** | **28 / 33** | **93,557** | **99** |

grep put the right note first for 6 questions and in the first five for 18. It read about
1.6 million tokens, roughly 50,000 per question, because common words match long files that
an agent then opens. brain put the right note first for 23 and in the first five for 28. It
read about 2,800 tokens per question, **17× less**, in about half the calls.
In wall time grep is faster (2.7 s for all 33 questions, against 8.5 s for brain's 99
calls, most of it Node start-up). For an agent, the calls and tokens are what cost time.

## Scale: what happens at thousands of notes

brain has no daemon: every command first checks the vault for changes and re-reads only what
changed ([how](indexing.md)). To see what that costs as a vault grows, the real vault's notes
were copied under unique names to 1,000, 5,000 and 20,000 notes, outside the vault. On each copy
we timed the first index, a no-change check, and the 33 questions as
`brain search` (change check included). Every number is a fresh `brain` process, Node start-up
included.

Apple M1, 16 GB, macOS 26.6, Node 22.23, local APFS disk:

| Notes | Markdown | First index | No-change check | Search p50 | Search p95 | Change check inside a search (p50) |
| --- | --- | --- | --- | --- | --- | --- |
| 138 | 2.6 MB | 0.27 s | 0.11 s | 91 ms | 123 ms | 8 ms |
| 1,000 | 19 MB | 0.66 s | 0.09 s | 89 ms | 112 ms | 22 ms |
| 5,000 | 93 MB | 2.8 s | 0.16 s | 169 ms | 230 ms | 91 ms |
| 20,000 | 374 MB | 16.7 s | 0.45 s | 461 ms | 712 ms | 334 ms |

Until a few thousand notes, a search costs about the same as Node start-up. At 20,000 notes
a search takes about half a second, and most of that is the change check, which stats every
note. The query itself stays in the tens of milliseconds. The first index grows with the
amount of text (these notes average 18 KB each, which is why the first build is slower than the
smaller synthetic notes in [indexing.md](indexing.md)), but it is paid once. After that only
changed notes are re-read.

So a vault that grows to thousands of notes needs nothing new. If one reaches tens of thousands
and an agent calls brain many times in a row, the change check is what to make cheaper. The
options are in [indexing.md](indexing.md#options-for-much-larger-vaults-not-built).
