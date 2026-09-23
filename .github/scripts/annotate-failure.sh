#!/usr/bin/env bash
# Turn the tail of a failed step's log into error annotations. Annotations show on the run
# page and in pull requests, and unlike raw logs they are readable without signing in.
#   annotate-failure.sh <log file> <title>
set -uo pipefail
file="$1"; title="${2:-failure}"
[ -f "$file" ] || exit 0
py="$(command -v python3 || command -v python)"
"$py" - "$file" "$title" <<'PY'
import re, sys
path, title = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8", errors="replace").read()
lines = [re.sub(r"\x1b\[[0-9;]*m", "", l) for l in text.splitlines()]
tail = lines[-150:]
chunks = [tail[i:i + 30] for i in range(0, len(tail), 30)]
enc = lambda s: s.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
for i, chunk in enumerate(chunks, 1):
    print(f"::error title={title} ({i}/{len(chunks)})::" + enc("\n".join(chunk)))
PY
