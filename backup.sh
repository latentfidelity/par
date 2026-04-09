#!/bin/bash
# PAR Daily Backup
# Keeps: 7 days of compressed backups

BACKUP_DIR="$(dirname "$0")/backups"
META_DIR="${META_DIR:-/data/meta}"
DATE=$(date +%Y%m%d_%H%M%S)
KEEP_DAYS=7

mkdir -p "$BACKUP_DIR"

# Create compressed backup
tar -czf "$BACKUP_DIR/par_meta_${DATE}.tar.gz" -C "$(dirname "$META_DIR")" "$(basename "$META_DIR")/"

# Rotate: delete backups older than $KEEP_DAYS days
find "$BACKUP_DIR" -name "par_meta_*.tar.gz" -mtime +${KEEP_DAYS} -delete

# Log
COUNT=$(ls "$BACKUP_DIR"/par_meta_*.tar.gz 2>/dev/null | wc -l)
SIZE=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)
echo "[$(date)] Backup complete: par_meta_${DATE}.tar.gz | ${COUNT} backups | ${SIZE} total"
