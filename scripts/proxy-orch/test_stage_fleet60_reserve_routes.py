from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("stage-fleet60-reserve-routes.py")
SPEC = importlib.util.spec_from_file_location("stage_fleet60_reserve_routes", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("unable to load reserve-route staging module")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

def manifest_fixture() -> dict:
    """Exercise the task-scoped schema without depending on private exports."""
    routes = []
    for route_id, expected in MODULE.EXPECTED_ROUTES.items():
        routes.append({
            "route_id": route_id, "provider": "Decodo", "classification": "dedicated_static",
            "assignment_state": "planned_replacement", "assigned_device_id": expected["assigned_device_id"],
            "assigned_fleet_vlan": 60, "adb_serial": expected["adb_serial"],
            "reserved_device_ip": expected["reserved_device_ip"],
            "clone_from": {"route_id": expected["clone_route_id"], "reserved_device_ip": expected["clone_device_ip"]},
            "internal_endpoint": {"hostname_or_ip": "192.168.52.10", "port": expected["listener_port"], "protocol": "http"},
            "provider_endpoint": {"hostname_or_ip": "dc.decodo.com", "port": expected["provider_port"], "protocol": "http_connect"},
            "location": {"country": "United States", "region": None, "city": None},
            "health_state": "not_verified", "expected_public_ip": expected["expected_public_ip"],
            "observed_public_ip": None, "last_verification_time": None, "rollout_state": "staged_only",
        })
    return {"schema_version": 1, "kind": "xpace.proxy_route_reserve.v1", "credential_free": True,
            "generated_at": "2026-01-01T00:00:00Z", "purpose": "Offline unit-test fixture", "routes": routes}


class ReserveRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        fixture_dir = tempfile.TemporaryDirectory(prefix="fleet-route-test-")
        cls.addClassCleanup(fixture_dir.cleanup)
        cls.manifest_path = Path(fixture_dir.name) / "manifest.json"
        cls.manifest_path.write_text(json.dumps(manifest_fixture()), encoding="utf-8")
        cls.routes = MODULE.load_routes(cls.manifest_path)

    def test_manifest_is_the_exact_credential_free_pair(self) -> None:
        self.assertEqual(
            [route["route_id"] for route in self.routes],
            ["fleet60-ip189-spare01", "fleet60-ip197-spare02"],
        )
        self.assertEqual([route["internal_endpoint"]["port"] for route in self.routes], [8221, 8222])

    def test_secret_bearing_keys_are_rejected_without_echoing_values(self) -> None:
        payload = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        payload["routes"][0]["provider_password"] = "do-not-echo-this"
        with self.assertRaises(MODULE.RouteStageError) as raised:
            MODULE.reject_secret_keys(payload)
        self.assertNotIn("do-not-echo-this", str(raised.exception))

    def test_config_clone_preserves_credentials_and_enforces_exclusive_source(self) -> None:
        template = (
            "auth strong\n"
            "allow * 192.168.60.189\n"
            "parent 1000 connect+ dc.decodo.com 10006 LOCAL_USER LOCAL_PASSWORD\n"
            "proxy -p8206 -i192.168.52.10\n"
            "deny *\n"
        )
        rewritten = MODULE.rewrite_config(template, self.routes[0])
        self.assertIn("allow * 192.168.60.189", rewritten)
        self.assertEqual(rewritten.count("allow * 192.168.60.189"), 1)
        self.assertIn("dc.decodo.com 10021 LOCAL_USER LOCAL_PASSWORD", rewritten)
        self.assertIn("proxy -p8221 -i192.168.52.10", rewritten)

    def test_config_clone_rejects_a_second_allow_rule(self) -> None:
        template = (
            "allow * 192.168.60.189\n"
            "allow * 192.168.60.189\n"
            "parent 1000 connect+ dc.decodo.com 10006 USER PASS\n"
            "proxy -p8206 -i192.168.52.10\n"
            "deny *\n"
        )
        with self.assertRaises(MODULE.RouteStageError):
            MODULE.rewrite_config(template, self.routes[0])

    def test_unit_clone_changes_only_the_declared_route_reference(self) -> None:
        source = (
            "[Service]\n"
            "ExecStart=/usr/local/bin/3proxy /etc/xpace/proxy/routes/fleet60-fleet6-dc06.cfg\n"
        )
        rewritten = MODULE.rewrite_unit(
            source, "fleet60-fleet6-dc06", "fleet60-ip189-spare01"
        )
        self.assertNotIn("fleet60-fleet6-dc06", rewritten)
        self.assertIn("fleet60-ip189-spare01", rewritten)


if __name__ == "__main__":
    unittest.main()
