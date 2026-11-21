"""Exercise the installed Grok CLI against a loopback model and a synthetic MCP PNG."""
import argparse
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading

REPO = Path(__file__).resolve().parents[1]
REGISTER = """
import { configureGrok } from './lcu/harness_setup.mjs';
const [root, fixture] = process.argv.slice(1);
configureGrok(process.env.HOME, [process.execPath, fixture], process.execPath, root,
  {scope: 'user', env: process.env});
"""


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"data":[{"id":"fixture","object":"model"}]}')

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        messages = body['messages']
        outputs = [m['content'] for m in messages if m['role'] == 'tool']
        tools = [t['function']['name'] for t in body.get('tools', [])]
        call = 'use_tool' in tools and not outputs
        if 'use_tool' in tools:
            self.server.samples.append((messages, outputs))
        args = {'tool_name': 'lcu__js', 'tool_input': {'code': 'lcu-result:image'}}
        delta = {'tool_calls': [{'index': 0, 'id': 'call-fixture', 'type': 'function',
                                 'function': {'name': 'use_tool', 'arguments': json.dumps(args)}}]} if call else {
            'content': 'Fixture finished.'}
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for chunk, finish in [(delta, None), ({}, 'tool_calls' if call else 'stop')]:
            data = {'id': 'fixture', 'object': 'chat.completion.chunk', 'model': 'fixture',
                    'choices': [{'index': 0, 'delta': chunk, 'finish_reason': finish}]}
            self.wfile.write(f'data: {json.dumps(data)}\n\n'.encode())
        self.wfile.write(b'data: [DONE]\n\n')


def exercise(root):
    home, project = root / 'home', root / 'project'
    project.mkdir()
    profile = home / '.grok'
    profile.mkdir(parents=True)
    log = root / 'results.jsonl'
    env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'GROK_HOME': str(profile),
           'XDG_CONFIG_HOME': str(home / '.config'), 'XDG_CACHE_HOME': str(home / '.cache'),
           'LCU_RESULT_LOG': str(log), 'LCU_DIAGNOSTIC_LOG': '0',
           'LCU_GROK_CONTROL_DIR': str(root / 'ipc'), 'GROK_TELEMETRY_ENABLED': '0', 'XAI_API_KEY': 'fixture'}
    with ThreadingHTTPServer(('127.0.0.1', 0), Model) as model:
        model.samples = []
        url = f'http://127.0.0.1:{model.server_port}/v1'
        (profile / 'config.toml').write_text(f'''[models]
default = "fixture"
[model.fixture]
model = "fixture"
base_url = "{url}"
api_key = "fixture"
api_backend = "chat_completions"
vision = true
[endpoints]
models_base_url = "{url}"
models_list_url = "{url}/models"
xai_api_base_url = "{url}"
[permission]
allow = ["MCPTool(lcu__js)"]
[compat.claude]
mcps = false
[compat.cursor]
mcps = false
''')
        for _ in range(2):
            subprocess.run(['node', '--input-type=module', '-e', REGISTER, str(REPO),
                            str(REPO / 'adapters/test/result-fixture.mjs')], cwd=REPO, env=env, check=True)
        threading.Thread(target=model.serve_forever, daemon=True).start()
        try:
            subprocess.run(['grok', '-p', 'Call the synthetic LCU fixture.', '-m', 'fixture'],
                           cwd=project, env=env, timeout=60, check=True)
        finally:
            model.shutdown()
        assert model.samples and 'Original CUA initialization guide.' in str(model.samples[0][0])
        entries = [json.loads(line) for line in log.read_text().splitlines()]
        call, end = [e for e in entries if e['kind'] == 'call']
        ids = call['meta']['x-codex-turn-metadata']
        assert call['name'] == 'js' and end['name'] == 'turn_ended'
        assert end['args'] == {'hook_event_name': 'Stop', 'session_id': ids['session_id'], 'turn_id': ids['turn_id']}
        image = next(e['result']['content'][0] for e in entries if e['kind'] == 'result')
        uri = 'data:image/png;base64,' + image['data']
        outputs = [value for _, values in model.samples for value in values]
        assert any(uri in json.dumps(value) for value in outputs), 'PNG missing from the model request'
        digest = hashlib.sha256(base64.b64decode(image['data'], validate=True)).hexdigest()
        # Grok passes the image to the model as a data URL inside the tool output text, not as image input.
        print(f'cli: PNG {digest} reached the model as a text data URL; matching Stop')


if __name__ == '__main__':
    argparse.ArgumentParser(description=__doc__).parse_args()
    with tempfile.TemporaryDirectory(prefix='lcu-grok-', dir='/tmp') as temp:
        exercise(Path(temp).resolve())
