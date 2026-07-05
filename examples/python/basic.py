from sdk.python.zenos_memory_client import ZenosMemoryClient

memory = ZenosMemoryClient()

memory.remember(
    'Zenos Memory Python SDK example ran successfully.',
    namespace='zenos',
    metadata={'source': 'example-python', 'importance': 4},
)

recall = memory.recall('Python SDK example', namespace='zenos', limit=3)
print({'count': recall.get('count'), 'first': (recall.get('results') or [{}])[0].get('id')})
