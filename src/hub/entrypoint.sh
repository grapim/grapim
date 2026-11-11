#!/bin/sh
# Container entrypoint for `grapim hub`.
#
# Platform volumes (Railway's among them) are mounted owned by root, so the
# image starts as root only long enough to give the data directory to the
# unprivileged `node` user, then drops to it for good. The server itself never
# runs as root. Started with --user already (not root), it just runs.
#
# As root this only ever touches HUB_DATA, and only when it is a dedicated
# directory: a mistyped HUB_DATA such as / or /app must not hand the system or
# the (read-only) app code to the runtime user. chown -R does not follow
# symbolic links (GNU chown defaults to -P with -R), so a link planted in the
# volume cannot redirect it. no_new_privs stops the server, if compromised,
# from regaining root through a setuid binary.
set -e
DATA="${HUB_DATA:-/data}"
if [ "$(id -u)" = "0" ]; then
  case "$DATA" in
    /*) ;;
    *) echo "grapim hub: HUB_DATA must be an absolute path (got: $DATA)" >&2; exit 1 ;;
  esac
  case "$DATA" in
    / | /app | /app/* | /bin* | /boot* | /dev* | /etc* | /home | /lib* | /proc* | /root* | /run* | /sbin* | /sys* | /usr* | /var | /tmp | *..*)
      echo "grapim hub: HUB_DATA must be a dedicated data directory such as /data (got: $DATA)" >&2
      exit 1
      ;;
  esac
  mkdir -p "$DATA"
  chown -R -P node:node "$DATA"
  chmod 700 "$DATA"
  exec setpriv --reuid=node --regid=node --init-groups --no-new-privs -- node --disable-warning=ExperimentalWarning /app/bin/grapim.js hub
fi
exec node --disable-warning=ExperimentalWarning /app/bin/grapim.js hub
