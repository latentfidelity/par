#!/bin/sh
# Ensure all meta directories exist AND are writable by the par user (UID 999).
# This is the self-healing fix for the root-ownership bug documented in the
# v5.0→v7.0 deploy incident: when Docker creates dirs as root during build,
# the non-root container process (UID 999) cannot write to them.
DIRS="kv files projects tasks snippets skills datasets memory artifacts agents events workflows procedures knowledge experiments .cache workflow_runs"
for dir in $DIRS; do
  mkdir -p /data/meta/$dir
done

# Fix ownership — this runs as root before privilege drop
chown -R 999:999 /data/meta 2>/dev/null || true

# Drop privileges to par user and exec the CMD
exec gosu par "$@"
