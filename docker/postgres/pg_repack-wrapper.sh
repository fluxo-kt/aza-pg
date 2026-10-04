#!/bin/bash
# pg_repack as shipped in this image. Installed as /usr/local/bin/pg_repack, which PATH resolves before
# the package's /usr/bin/pg_repack, so the package files stay untouched.
#
# The image preloads safeupdate, which rejects DELETE without WHERE; pg_repack's own
# `DELETE FROM repack.log_N` is such a statement, so the unwrapped client fails mid-repack. This turns
# safeupdate off for pg_repack's sessions only (PGOPTIONS reaches the server at connect time) and keeps
# any PGOPTIONS the caller set. From another machine, run the client with the same setting:
#   PGOPTIONS="-c safeupdate.enabled=off" pg_repack -h <host> ...
set -euo pipefail

real="/usr/lib/postgresql/${PG_MAJOR:?PG_MAJOR is unset; it comes from the postgres base image}/bin/pg_repack"
if [ ! -x "$real" ]; then
  echo "pg_repack: $real not found; is pg_repack enabled in this image's manifest?" >&2
  exit 127
fi
PGOPTIONS="-c safeupdate.enabled=off ${PGOPTIONS:-}" exec "$real" "$@"
