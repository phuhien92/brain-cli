# `brain bench` extension

Runs a question file three ways — an agent's grep loop, the Obsidian CLI, and brain — and
reports whether each found the expected note (top 1 / top 5), how many tokens it read and how
many commands it took. The method and published results are in
[docs/benchmark.md](../../docs/benchmark.md).

```sh
cp -R examples/bench/demo /tmp/brain-demo     # enabling writes a note into the vault, so use a copy
brain ext install ./examples/bench --vault /tmp/brain-demo   # review and approve in a terminal
brain bench questions.jsonl --vault /tmp/brain-demo
```

The extension reads the whole vault and writes nothing. `demo/` is a small public vault with
`demo/questions.jsonl`; CI runs it on every push. To benchmark a vault without enabling the
extension in it, run the script directly:

```sh
node examples/bench/bin/brain-bench /outside/the/vault/questions.jsonl --vault ~/vault
```
