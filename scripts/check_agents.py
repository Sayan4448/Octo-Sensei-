#!/usr/bin/env python3
"""Check every Claude Code agent in .claude/agents/: YAML front matter with a name and a description,
and a name equal to the file name. Run with no argument; `--self-test` checks the checker itself."""
import pathlib
import re
import sys

NAME = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")


def problems(path: pathlib.Path, text: str) -> list[str]:
    # shortcut: reads only flat `key: value` lines, enough for agent headers; use a YAML parser if they nest.
    if not text.startswith("---\n") or "\n---\n" not in text[4:]:
        return [f"{path}: missing front matter between --- lines"]
    header, body = text[4:].split("\n---\n", 1)
    fields = dict(line.split(":", 1) for line in header.splitlines() if ":" in line)
    fields = {k.strip(): v.strip() for k, v in fields.items()}
    errors = [f"{path}: missing '{key}'" for key in ("name", "description") if not fields.get(key)]
    name = fields.get("name", "")
    if name and not NAME.fullmatch(name):
        errors.append(f"{path}: name '{name}' must be lowercase words joined by dashes")
    if name and name != path.stem:
        errors.append(f"{path}: name '{name}' must match the file name '{path.stem}'")
    if not body.strip():
        errors.append(f"{path}: the agent has no instructions after the front matter")
    return errors


def self_test() -> None:
    p = pathlib.Path("octo.md")
    assert problems(p, "---\nname: octo\ndescription: d\n---\nHi\n") == []
    assert problems(p, "no header") == [f"{p}: missing front matter between --- lines"]
    assert problems(p, "---\nname: other\ndescription: d\n---\nHi\n") == [f"{p}: name 'other' must match the file name 'octo'"]
    assert problems(p, "---\nname: octo\n---\nHi\n") == [f"{p}: missing 'description'"]
    assert problems(p, "---\nname: octo\ndescription: d\n---\n\n") == [f"{p}: the agent has no instructions after the front matter"]
    assert "lowercase" in problems(pathlib.Path("Octo.md"), "---\nname: Octo\ndescription: d\n---\nHi\n")[0]
    print("self-test ok")


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return 0
    agents = sorted(pathlib.Path(".claude/agents").glob("*.md"))
    if not agents:
        print("no agent found in .claude/agents/")
        return 1
    errors = [e for a in agents for e in problems(a, a.read_text(encoding="utf-8"))]
    print("\n".join(errors) or f"{len(agents)} agent(s) ok: " + ", ".join(a.stem for a in agents))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
