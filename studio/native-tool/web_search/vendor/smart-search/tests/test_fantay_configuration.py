import asyncio
import io
import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from smart_search import cli, service
from smart_search.config import config
from smart_search.desktop_catalog import command_catalog
from smart_search.providers.xai_responses import XAIResponsesSearchProvider


@pytest.fixture(autouse=True)
def reset_catalog_cache():
    command_catalog.cache_clear()
    yield
    command_catalog.cache_clear()


def mock_endpoint(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))


def test_custom_responses_configuration_from_stdin(monkeypatch, tmp_path, capsys):
    profile = tmp_path / "fantay"
    profile.mkdir()
    original = {"EXA_ENABLED": "false", "XAI_ENABLED": "false", "OPENAI_COMPATIBLE_MODEL": "saved-model"}
    config_file = profile / "config.json"
    config_file.write_text(json.dumps(original))
    requests = []
    secret = "synthetic-private-fantay-key"

    def handler(request):
        assert request.headers["Authorization"] == f"Bearer {secret}"
        if request.method == "GET":
            return httpx.Response(200, json={"data": [{"id": "custom-grok"}]})
        assert str(request.url) == "https://relay.example/v1/responses"
        payload = json.loads(request.content)
        requests.append(payload)
        return httpx.Response(200, json={"output": [{"type": "message", "content": [{
            "type": "output_text", "text": "The source explains the requested topic.",
            "annotations": [{"type": "url_citation", "url": "https://example.org/source", "title": "Source"}],
        }]}]})

    mock_endpoint(monkeypatch, handler)
    overrides = {
        "OPENAI_COMPATIBLE_API_URL": "https://relay.example/v1/responses",
        "OPENAI_COMPATIBLE_API_KEY": secret,
        "OPENAI_COMPATIBLE_API_MODE": "responses",
        "OPENAI_COMPATIBLE_TOOLS": "web_search,x_search",
        "OPENAI_COMPATIBLE_MODEL": "custom-grok",
        "SMART_SEARCH_INTENT_ROUTER": "local",
    }
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(overrides)))
    code = cli.main(["--config-dir", str(profile), "--config-stdin", "search", "Explain the topic",
                     "--providers", "openai-compatible", "--fallback", "off", "--format", "json"])
    output = capsys.readouterr().out
    result = json.loads(output)
    assert code == 0, result
    assert requests[0]["model"] == "custom-grok"
    assert requests[0]["tools"] == [{"type": "web_search"}, {"type": "x_search"}]
    assert secret not in output
    assert json.loads(config_file.read_text()) == original
    assert config.openai_compatible_api_key is None


@pytest.mark.parametrize("body", ['[]', '{"UNKNOWN_KEY":"value"}', '{"XAI_API_KEY":123}', '{invalid'])
def test_stdin_configuration_rejects_invalid_objects(monkeypatch, capsys, body):
    monkeypatch.setattr("sys.stdin", io.StringIO(body))
    assert cli.main(["--config-stdin", "model", "current"]) == cli.EXIT_PARAMETER_ERROR
    assert json.loads(capsys.readouterr().out)["error_type"] == "parameter_error"


def test_stdin_configuration_cannot_write_saved_profile(monkeypatch, capsys):
    config.set_config_value("XAI_MODEL", "saved-model")
    monkeypatch.setattr("sys.stdin", io.StringIO('{"XAI_MODEL":"temporary-model"}'))
    assert cli.main(["--config-stdin", "model", "set", "changed", "--provider", "xai-responses"]) == 2
    assert json.loads(capsys.readouterr().out)["error_type"] == "parameter_error"
    assert config.xai_model == "saved-model"


def test_model_selection_updates_only_requested_provider(tmp_path, capsys):
    profile = tmp_path / "profile"
    profile.mkdir()
    saved = {"XAI_MODEL": "grok-before", "OPENAI_COMPATIBLE_MODEL": "other-model"}
    path = profile / "config.json"
    path.write_text(json.dumps(saved))
    assert cli.main(["--config-dir", str(profile), "model", "set", "custom-grok",
                     "--provider", "xai-responses"]) == 0
    assert json.loads(capsys.readouterr().out)["ok"]
    assert json.loads(path.read_text()) == {**saved, "XAI_MODEL": "custom-grok"}


def test_model_list_is_available_through_cli_and_native_catalog(monkeypatch, capsys):
    config.set_config_value("XAI_API_KEY", "synthetic-key")
    config.set_config_value("XAI_API_URL", "https://relay.example/v1/responses")
    config.set_config_value("XAI_MODEL", "custom-grok")
    methods = []

    def handler(request):
        methods.append(request.method)
        assert str(request.url) == "https://relay.example/v1/models"
        return httpx.Response(200, json={"data": [{"id": "custom-grok"}, {"id": "another-model"}, {"id": "custom-grok"}]})

    mock_endpoint(monkeypatch, handler)
    assert cli.main(["model", "list", "--provider", "xai-responses"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["providers"][0]["models"] == ["custom-grok", "another-model"]
    assert methods == ["GET"]
    assert "model/list" in {entry["id"] for entry in command_catalog()}


@pytest.mark.asyncio
async def test_concurrent_model_inventories_use_separate_configuration(monkeypatch):
    async def handler(request):
        await asyncio.sleep(0)
        credential = request.headers["Authorization"].removeprefix("Bearer ")
        return httpx.Response(200, json={"data": [{"id": credential + "-model"}]})

    mock_endpoint(monkeypatch, handler)

    async def inventory(name):
        with config.snapshot({"XAI_API_KEY": name, "XAI_API_URL": f"https://{name}.example/v1"}):
            return await service.list_models("xai-responses")

    first, second = await asyncio.gather(inventory("first"), inventory("second"))
    assert first["providers"][0]["models"] == ["first-model"]
    assert second["providers"][0]["models"] == ["second-model"]
    assert config.xai_api_key is None


@pytest.mark.asyncio
async def test_model_inventory_errors_redact_credentials(monkeypatch):
    secret = "synthetic-private-list-secret"
    config.set_config_value("XAI_API_KEY", secret)
    mock_endpoint(monkeypatch, lambda request: httpx.Response(401, text="Rejected " + secret))
    result = await service.list_models("xai-responses")
    assert result["error_type"] == "auth_error"
    assert secret not in json.dumps(result)


def test_xai_accepts_full_custom_responses_endpoint():
    provider = XAIResponsesSearchProvider("https://relay.example/v1/responses/", "synthetic-key")
    assert provider.api_url == "https://relay.example/v1"


def test_subprocess_accepts_private_configuration_and_returns_json(tmp_path):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            response = json.dumps({"output": [{"type": "message", "content": [{
                "type": "output_text", "text": "Retrieved source information.", "annotations": [
                    {"type": "url_citation", "url": "https://example.org/source", "title": "Source"},
                ],
            }]}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    values = {"XAI_ENABLED": "false", "OPENAI_COMPATIBLE_API_URL": f"http://127.0.0.1:{server.server_port}/v1",
              "OPENAI_COMPATIBLE_API_KEY": "synthetic-private-input", "OPENAI_COMPATIBLE_API_MODE": "responses",
              "OPENAI_COMPATIBLE_MODEL": "chosen-by-fantay", "OPENAI_COMPATIBLE_TOOLS": "web_search,x_search",
              "SMART_SEARCH_INTENT_ROUTER": "local"}
    try:
        result = subprocess.run([sys.executable, "-m", "smart_search.cli", "--config-dir", str(tmp_path),
                                 "--config-stdin", "search", "Find the source", "--providers", "openai-compatible",
                                 "--fallback", "off", "--format", "json"], input=json.dumps(values),
                                text=True, capture_output=True, timeout=15)
        assert result.returncode == 0, result.stderr + result.stdout
        assert json.loads(result.stdout)["ok"]
        assert requests[0]["model"] == "chosen-by-fantay"
        assert requests[0]["tools"] == [{"type": "web_search"}, {"type": "x_search"}]
        assert "synthetic-private-input" not in result.stdout + result.stderr
        assert not (tmp_path / "config.json").exists()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
