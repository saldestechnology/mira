#!/usr/bin/env bash
# One-time setup of the Tabula backup puller on the backup host. Run it as root, by hand:
#
#   sudo bash host-setup.sh            # asks before every step
#   sudo bash host-setup.sh --dry-run  # prints what it would do, changes nothing
#
# It touches ONLY: the user `tabula-backup`, that user's home directory, and that user's lingering flag.
# It never touches any other user, home, service, cron job, firewall rule or package.
# It runs again safely: a step that is already done says so and is skipped.
#
# Secrets: the pull master is typed at the prompt (hidden), never taken from arguments or the environment, never printed,
# and is written once to a file the puller user can read but not change. The backup KEY is never asked for and must never be put on this host.
set -euo pipefail
umask 077

USER_NAME=tabula-backup
HOME_DIR=/home/$USER_NAME
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

say() { printf '%s\n' "$*"; }
run() { if (( DRY )); then say "   [dry-run] $*"; else "$@"; fi; }

ask() { # ask "what" -> returns 0 when the person says yes
  say ""
  say "STEP: $1"
  if (( DRY )); then say "   [dry-run] would ask: continue? [y/N]"; return 0; fi
  local answer
  read -r -p "   Do this? [y/N/q] " answer
  case "$answer" in y|Y) return 0 ;; q|Q) say "Stopped. Nothing further was changed."; exit 0 ;; *) say "   Skipped."; return 1 ;; esac
}

if [[ $EUID -ne 0 ]]; then say "Run this as root (sudo bash $0)."; exit 1; fi
for f in pull.mjs restore-check.mjs systemd/tabula-backup-pull.service systemd/tabula-backup-pull.timer systemd/tabula-backup-check.service systemd/tabula-backup-check.timer; do
  [[ -f "$HERE/$f" ]] || { say "Missing $HERE/$f: copy the whole deploy/backup-puller folder to the host first."; exit 1; }
done

NODE_BIN="$(command -v node || true)"
say "This will set up the Tabula backup puller for user '$USER_NAME' (home $HOME_DIR)."
say "Found node: ${NODE_BIN:-none}"
if [[ -z "$NODE_BIN" ]]; then say "Node 24 or newer must be installed system-wide first (this script installs no packages)."; exit 1; fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 24 )); then say "node $NODE_MAJOR found; version 24 or newer is required."; exit 1; fi

# 1 --------------------------------------------------------------------------------------------------------------------
if id "$USER_NAME" >/dev/null 2>&1; then
  say ""; say "STEP 1: user $USER_NAME already exists: skipped."
elif ask "1. Create the user '$USER_NAME' (no password, no sudo, login shell /bin/bash so its user services can run)"; then
  run useradd --create-home --home-dir "$HOME_DIR" --shell /bin/bash --comment "Tabula backup puller" "$USER_NAME"
  run passwd -l "$USER_NAME"
fi
if ! (( DRY )) && ! id "$USER_NAME" >/dev/null 2>&1; then say "The user does not exist; cannot continue."; exit 1; fi
if (( ! DRY )); then
  case "$(getent passwd "$USER_NAME" | cut -d: -f6)" in "$HOME_DIR") ;; *) say "Home of $USER_NAME is not $HOME_DIR; stopping."; exit 1 ;; esac
fi

# 2 --------------------------------------------------------------------------------------------------------------------
if ask "2. Create the folders $HOME_DIR/{bin,etc,store,state} (store and state private to the user; etc and bin owned by root, read-only to the user)"; then
  run install -d -m 0700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/store" "$HOME_DIR/state"
  run install -d -m 0755 -o root -g root "$HOME_DIR/bin"
  run install -d -m 0750 -o root -g "$USER_NAME" "$HOME_DIR/etc"
fi

# 3 --------------------------------------------------------------------------------------------------------------------
if ask "3. Copy pull.mjs and restore-check.mjs to $HOME_DIR/bin (root-owned, so the puller cannot rewrite its own code)"; then
  run install -m 0755 -o root -g root "$HERE/pull.mjs" "$HOME_DIR/bin/pull.mjs"
  run install -m 0755 -o root -g root "$HERE/restore-check.mjs" "$HOME_DIR/bin/restore-check.mjs"
fi

# 4 --------------------------------------------------------------------------------------------------------------------
CONF="$HOME_DIR/etc/puller.json"
if ask "4. Write the puller config $CONF (paths under $HOME_DIR, 7 daily + 4 weekly retention, objects kept 35 days after the source drops them; edit the file later to change this)"; then
  if [[ -f "$CONF" && $DRY -eq 0 ]]; then
    say "   $CONF exists: kept as it is."
  else
    TMP="$(mktemp)"
    cat > "$TMP" <<JSON
{
  "storeDir": "$HOME_DIR/store",
  "stateDir": "$HOME_DIR/state",
  "pullMasterFile": "$HOME_DIR/etc/pull-master",
  "workspacesFile": "$HOME_DIR/state/workspaces.json",
  "prefix": "tabula",
  "baseUrlTemplate": "https://{slug}.thetabula.cloud",
  "concurrency": 2,
  "keepDaily": 7,
  "keepWeekly": 4,
  "objectGraceDays": 35,
  "metricsFile": "$HOME_DIR/state/tabula_backup.prom",
  "requestTimeoutSeconds": 120
}
JSON
    run install -m 0640 -o root -g "$USER_NAME" "$TMP" "$CONF"
    rm -f "$TMP"
  fi
fi

# 5 --------------------------------------------------------------------------------------------------------------------
MASTER="$HOME_DIR/etc/pull-master"
if ask "5. Store the pull master in $MASTER (you type it now, hidden; root-owned, readable by $USER_NAME only through its group, never printed)"; then
  if (( DRY )); then
    say "   [dry-run] would read the master from the terminal without echo and write it to $MASTER"
  else
    REPLACE=y
    if [[ -s "$MASTER" ]]; then read -r -p "   $MASTER already holds a master. Replace it? [y/N] " REPLACE; fi
    if [[ "$REPLACE" == "y" || "$REPLACE" == "Y" ]]; then
      read -r -s -p "   Pull master: " M1; echo
      read -r -s -p "   Again:       " M2; echo
      if [[ -z "$M1" || "$M1" != "$M2" ]]; then say "   Empty or different: nothing written."; unset M1 M2; else
        install -m 0440 -o root -g "$USER_NAME" /dev/null "$MASTER.new"
        printf '%s\n' "$M1" > "$MASTER.new"
        mv -f "$MASTER.new" "$MASTER"
        unset M1 M2
        say "   Written (length hidden)."
      fi
    else say "   Kept the existing master."; fi
  fi
fi

# 6 --------------------------------------------------------------------------------------------------------------------
WS="$HOME_DIR/state/workspaces.json"
if ask "6. Create an empty workspace list $WS (the control plane or you fill it: [{\"id\":\"...\",\"slug\":\"...\",\"state\":\"running\"}])"; then
  if [[ -f "$WS" && $DRY -eq 0 ]]; then say "   exists: kept."; else
    TMP="$(mktemp)"; echo '[]' > "$TMP"
    run install -m 0600 -o "$USER_NAME" -g "$USER_NAME" "$TMP" "$WS"; rm -f "$TMP"
  fi
fi

# 7 --------------------------------------------------------------------------------------------------------------------
UNITS="$HOME_DIR/.config/systemd/user"
if ask "7. Install the systemd USER units (daily pull, weekly structure check) in $UNITS and enable the timers; turn on lingering for $USER_NAME so they run without a login"; then
  run install -d -m 0755 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.config" "$HOME_DIR/.config/systemd" "$UNITS" "$UNITS/timers.target.wants"
  for u in tabula-backup-pull.service tabula-backup-pull.timer tabula-backup-check.service tabula-backup-check.timer; do
    if (( DRY )); then say "   [dry-run] install $u (with node path $NODE_BIN)"; else
      sed "s#@NODE@#$NODE_BIN#g; s#@HOME@#$HOME_DIR#g" "$HERE/systemd/$u" > "$UNITS/$u.tmp"
      chown "$USER_NAME:$USER_NAME" "$UNITS/$u.tmp"; chmod 0644 "$UNITS/$u.tmp"; mv -f "$UNITS/$u.tmp" "$UNITS/$u"
    fi
  done
  for t in tabula-backup-pull.timer tabula-backup-check.timer; do
    run ln -sfn "../$t" "$UNITS/timers.target.wants/$t"
    run chown -h "$USER_NAME:$USER_NAME" "$UNITS/timers.target.wants/$t"
  done
  run loginctl enable-linger "$USER_NAME"
  say "   Timers are enabled; they start at the next boot of the user manager. To start them now:"
  say "     systemctl --user -M $USER_NAME@ daemon-reload && systemctl --user -M $USER_NAME@ start tabula-backup-pull.timer tabula-backup-check.timer"
fi

say ""
say "Done. Next, by hand:"
say "  1. Fill $WS with the workspaces to pull."
say "  2. Test once: sudo -u $USER_NAME $NODE_BIN $HOME_DIR/bin/pull.mjs --config $CONF --dry-run"
say "  3. Point the host's Prometheus (node_exporter textfile collector or a file_sd) at $HOME_DIR/state/tabula_backup.prom (see README)."
say "  4. The backup KEY stays off this host. Restore checks with the key run on your own machine (README)."
