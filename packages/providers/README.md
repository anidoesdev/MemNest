# @memnest/providers

Model providers for Memnest: Ollama (native API, with JSON-schema-constrained output), any OpenAI-compatible endpoint, and Voyage embeddings. All providers have timeouts, retries with backoff and dimension checks.

```ts
import { ollamaCompletion, openAICompatibleEmbeddings, providersFromEnv } from '@memnest/providers';

const completion = ollamaCompletion({ model: 'llama3.1:8b' });
const embedder = openAICompatibleEmbeddings({ baseURL: 'http://localhost:1234/v1', model: 'my-embed', dimensions: 1024 });

// Or from MEMNEST_* environment variables:
const { completion: c, embedder: e } = providersFromEnv();
```
