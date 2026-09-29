from __future__ import annotations

import json

from manguadu.local_server_control import (
    get_volume_id_from_path,
    normalize_docker_state,
    parse_docker_ps_json,
    score_docker_container,
)


def test_local_server_container_matching() -> None:
    container = parse_docker_ps_json(json.dumps({
        "ID": "abc123456789", "Names": "pz-world", "Image": "pterodactyl/yolks",
        "State": "running", "Status": "Up 2 hours", "Labels": "io.pterodactyl.server=server-uuid",
        "Mounts": "volume-id:/home/container",
    }))[0]

    assert get_volume_id_from_path("/var/lib/pterodactyl/volumes/volume-id/Zomboid/Lua") == "volume-id"
    assert score_docker_container(container, ["server-uuid", "volume-id"]) == 22
    assert normalize_docker_state("exited") == "offline"
    assert normalize_docker_state("restarting") == "starting"
