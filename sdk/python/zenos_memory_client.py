import hashlib
import hmac
import json
import os
import time
import urllib.request
from urllib.parse import urlencode


class ZenosMemoryClient:
    def __init__(self, base_url='https://zenos-memory.vercel.app', secret=None):
        self.base_url = base_url.rstrip('/')
        self.secret = secret or os.environ.get('ETLA_MASTER_SECRET') or os.environ.get('ZENOS_MEMORY_SECRET')
        if not self.secret:
            raise ValueError('ZenosMemoryClient requires secret')
        self.secret = str(self.secret)

    def _headers(self, method, path):
        ts = str(int(time.time() * 1000))
        payload = f'{ts}:{method.upper()}:{path}'
        sig = hmac.new(self.secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
        return {'x-etla-timestamp': ts, 'x-etla-signature': sig, 'content-type': 'application/json'}

    def request(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base_url + path, data=data, headers=self._headers(method, path), method=method.upper())
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}

    def remember(self, content, type='fact', namespace='zenos', metadata=None):
        return self.request('POST', '/api/memory/remember', {'content': content, 'type': type, 'namespace': namespace, 'metadata': metadata or {}})

    def recall(self, query, namespace='zenos', limit=10, include_secrets=False, include_low_quality=False):
        return self.request('POST', '/api/memory/hybrid-recall', {'query': query, 'namespace': namespace, 'limit': limit, 'include_secrets': include_secrets, 'include_low_quality': include_low_quality})

    def compact(self, messages, namespace='zenos', reason='sdk'):
        return self.request('POST', '/api/memory/compact', {'messages': messages, 'namespace': namespace, 'reason': reason})

    def ingest(self, filename, content, namespace='zenos', agent_id=None):
        return self.request('POST', '/api/memory/upload', {'filename': filename, 'content': content, 'namespace': namespace, 'agentId': agent_id})

    def timeline(self, namespace='zenos', limit=100, entity=None):
        params = {'namespace': namespace, 'limit': str(limit)}
        if entity:
            params['entity'] = entity
        return self.request('GET', '/api/memory/timeline?' + urlencode(params))

    def mutation_plan(self, content, namespace='zenos', limit=200):
        return self.request('POST', '/api/memory/mutation-plan', {'content': content, 'namespace': namespace, 'limit': limit})

    def benchmark(self, skip_llm=True):
        return self.request('POST', '/api/memory/benchmark', {'skip_llm': skip_llm})
