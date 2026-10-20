import contextlib
from email.message import Message
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parent.parent
DIGEST = 'sha256:b1e78f03d5108eb985d4b00aa6726a0179b1623124f92cafb884aa4554e38b24'
PROFILE = {
    'schemaVersion': 2,
    'mediaType': 'application/vnd.oci.image.manifest.v1+json',
    'artifactType': 'application/vnd.docker.mcp.profile.v1+json',
    'config': {'mediaType': 'application/vnd.oci.empty.v1+json', 'size': 2},
    'layers': [{'mediaType': 'application/json', 'size': 5623}],
}


def python_step(filename, name):
    workflow = (REPO / '.github/workflows' / filename).read_text(encoding='utf-8')
    step = workflow.split(f'      - name: {name}\n', 1)[1].split('\n      - name:', 1)[0]
    script = textwrap.dedent(step.split('        run: |\n', 1)[1])
    if "python3 - <<'PY'\n" not in script:
        raise AssertionError('No manifest classifier: workflow still attempts Docker pull unconditionally')
    return textwrap.dedent(script.split("python3 - <<'PY'\n", 1)[1].split('\nPY', 1)[0])


class Response(io.BytesIO):
    def __init__(self, value, headers=None):
        super().__init__(json.dumps(value).encode())
        self.headers = headers or {}


class ManifestDiagnosticTests(unittest.TestCase):
    def run_manifest(self, manifest, pull_code=0, child=None):
        source = python_step('m0-image-diagnostic.yml', 'Inspect public Docker Hub repository and latest manifest')
        commands = []

        def open_url(request):
            url = request.full_url if hasattr(request, 'full_url') else request
            if 'auth.docker.io/token?' in url:
                return Response({'token': 'fixture-public-pull-token'})
            if '/tags/list?' in url:
                return Response({'name': 'zoonqi/ai_coding', 'tags': ['latest']})
            return Response(child if child is not None and '/manifests/sha256:' in url else manifest,
                            {'Docker-Content-Digest': DIGEST})

        def run_command(command, **kwargs):
            commands.append(command)
            return subprocess.CompletedProcess(command, pull_code if command[:2] == ['docker', 'pull'] else 0)

        with tempfile.TemporaryDirectory() as directory:
            outputs = Path(directory) / 'outputs'
            summary = Path(directory) / 'summary'
            output = io.StringIO()
            error = None
            with patch.dict(os.environ, {'GITHUB_OUTPUT': str(outputs), 'GITHUB_STEP_SUMMARY': str(summary)}), \
                    patch('urllib.request.urlopen', open_url), patch('subprocess.run', run_command), \
                    contextlib.redirect_stdout(output):
                try:
                    exec(compile(source, '<workflow diagnostic>', 'exec'), {})
                except subprocess.CalledProcessError as exc:
                    error = exc
            return commands, outputs.read_text(), summary.read_text(), output.getvalue(), error

    def test_mcp_profile_is_blocked_without_docker_pull(self):
        commands, outputs, summary, stdout, error = self.run_manifest(PROFILE)
        self.assertEqual(commands, [])
        self.assertIn('runnable=false', outputs)
        self.assertIn('BLOCKED', summary)
        self.assertIn(DIGEST, summary)
        self.assertIn('application/vnd.docker.mcp.profile.v1+json', summary)
        self.assertIn('::add-mask::fixture-public-pull-token', stdout)
        self.assertIsNone(error)

    def test_runtime_image_is_pulled_by_digest_for_linux_amd64(self):
        runtime = {**PROFILE, 'artifactType': None, 'config': {'mediaType': 'application/vnd.oci.image.config.v1+json'}}
        commands, outputs, summary, stdout, error = self.run_manifest(runtime)
        pull = next(command for command in commands if command[:2] == ['docker', 'pull'])
        self.assertIn('linux/amd64', pull)
        self.assertIn('docker.io/zoonqi/ai_coding@' + DIGEST, pull)
        self.assertIn('runnable=true', outputs)
        self.assertIn('Pull result: passed', summary)
        self.assertIsNone(error)

    def test_runtime_pull_failure_fails_the_diagnostic(self):
        runtime = {**PROFILE, 'artifactType': None, 'config': {'mediaType': 'application/vnd.oci.image.config.v1+json'}}
        commands, outputs, summary, stdout, error = self.run_manifest(runtime, pull_code=1)
        self.assertIsInstance(error, subprocess.CalledProcessError)
        self.assertIn('Pull result: failed', summary)
        self.assertEqual(len(commands), 1)

    def test_index_inspects_matching_platform_before_pulling(self):
        runtime = {**PROFILE, 'artifactType': None, 'config': {'mediaType': 'application/vnd.oci.image.config.v1+json'}}
        index = {'mediaType': 'application/vnd.oci.image.index.v1+json', 'manifests': [
            {'digest': 'sha256:arm', 'platform': {'os': 'linux', 'architecture': 'arm64'}},
            {'digest': 'sha256:amd', 'platform': {'os': 'linux', 'architecture': 'amd64'}},
        ]}
        commands, outputs, summary, stdout, error = self.run_manifest(index, child=runtime)
        self.assertIn('sha256:amd', summary)
        self.assertIn('runnable=true', outputs)
        self.assertIsNone(error)


class StaticAppSmokeTests(unittest.TestCase):
    def run_smoke(self, html, script=b'console.log("static app");', mime='application/javascript'):
        source = python_step('m0-container-probe.yml', 'Smoke test the web app')

        class WebResponse(io.BytesIO):
            status = 200

            def __init__(self, content, content_type):
                super().__init__(content)
                self.headers = Message()
                self.headers['Content-Type'] = content_type

            def geturl(self):
                return 'http://127.0.0.1:3000/'

        def open_url(url, **kwargs):
            return WebResponse(html, 'text/html') if url.endswith(':3000/') else WebResponse(script, mime)

        with patch('urllib.request.urlopen', open_url), patch('subprocess.run') as docker_logs, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            error = None
            try:
                exec(compile(source, '<workflow smoke>', 'exec'), {})
            except AssertionError as exc:
                error = exc
            return error, output.getvalue(), docker_logs.call_count

    def test_root_and_referenced_javascript_pass(self):
        error, output, logs = self.run_smoke(b'<html><div id="root"></div><script type="module" src="/assets/index.js"></script></html>')
        self.assertIsNone(error)
        self.assertIn('JavaScript smoke passed', output)
        self.assertEqual(logs, 0)

    def test_unrelated_html_does_not_count_as_the_app(self):
        error, output, logs = self.run_smoke(b'<html><h1>Welcome</h1></html>')
        self.assertIn('React root', str(error))
        self.assertEqual(logs, 1)

    def test_spa_html_fallback_for_javascript_fails(self):
        error, output, logs = self.run_smoke(b'<div id="root"></div><script type="module" src="/assets/missing.js"></script>',
                                               script=b'<html>fallback</html>', mime='text/html')
        self.assertIn('served as text/html', str(error))
        self.assertEqual(logs, 1)

    def test_html_content_with_javascript_mime_still_fails(self):
        error, output, logs = self.run_smoke(b'<div id="root"></div><script type="module" src="/assets/index.js"></script>',
                                               script=b'<!doctype html><html>fallback</html>')
        self.assertIn('contains HTML', str(error))
        self.assertEqual(logs, 1)


if __name__ == '__main__':
    unittest.main()
