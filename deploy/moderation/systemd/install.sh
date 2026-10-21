#!/bin/sh
# Install and enable the moderation timers on the host (docs/specs/moderation-v1.md §4.1).
#   sudo ./install.sh              install or update the units, enable and start both timers
#   sudo ./install.sh --uninstall  stop and disable the timers, remove the units
# Prints every step. Needs root (writes /etc/systemd/system). Run it from a clone of the
# repository; the units point at the clone's deploy/moderation directory.
set -eu

UNITS="crokychords-moderation.service crokychords-moderation.timer crokychords-moderation-digest.service crokychords-moderation-digest.timer"
TIMERS="crokychords-moderation.timer crokychords-moderation-digest.timer"
TARGET=/etc/systemd/system

here=$(cd "$(dirname "$0")" && pwd)
deploy_dir=$(dirname "$here")

step() {
	echo "+ $*"
	"$@"
}

if [ "$(id -u)" -ne 0 ]; then
	echo "install.sh needs root: sudo $0 $*" >&2
	exit 1
fi

if [ "${1:-}" = "--uninstall" ]; then
	for t in $TIMERS; do step systemctl disable --now "$t" || true; done
	for u in $UNITS; do step rm -f "$TARGET/$u"; done
	step systemctl daemon-reload
	echo "Removed. The image and the models volume are kept (docker compose down --rmi local -v removes them)."
	exit 0
fi

docker=$(command -v docker || true)
if [ -z "$docker" ]; then
	echo "docker not found in PATH" >&2
	exit 1
fi
if [ ! -f "$deploy_dir/compose.yml" ]; then
	echo "compose.yml not found in $deploy_dir" >&2
	exit 1
fi
if [ ! -f "$deploy_dir/moderation.env" ]; then
	echo "warning: $deploy_dir/moderation.env is missing; the job will exit until it exists" >&2
fi

echo "Deploy directory: $deploy_dir"
echo "Docker: $docker"
for u in $UNITS; do
	echo "+ install $here/$u -> $TARGET/$u"
	sed -e "s|@DEPLOY_DIR@|$deploy_dir|g" -e "s|@DOCKER@|$docker|g" "$here/$u" >"$TARGET/$u.tmp"
	chmod 644 "$TARGET/$u.tmp"
	mv "$TARGET/$u.tmp" "$TARGET/$u"
done
step systemctl daemon-reload
for t in $TIMERS; do step systemctl enable --now "$t"; done
step systemctl list-timers --no-pager $TIMERS
echo "Done. Logs: journalctl -u crokychords-moderation.service -u crokychords-moderation-digest.service"
