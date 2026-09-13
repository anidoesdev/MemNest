# @memnest/evals

The Memnest eval harness. Cases cover contradiction, duplicate, extends, expiry, precision at scale, pronoun resolution, noise rejection, secrets, session grouping, profiles and semantic recall. Run them with scripted models in CI, or live against your own.

```sh
memnest eval                       # scripted models
memnest eval --live --store postgres
```

```ts
import { runEvals, formatReport } from '@memnest/evals';
console.log(formatReport(await runEvals({ mode: 'mock', store: 'sqlite' })));
```
