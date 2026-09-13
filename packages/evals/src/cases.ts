import { CREDENTIAL_FIXTURES, credentialTranscript } from '@memnest/core/testing';
import type { EvalCase } from './types';

const candidate = (content: string, kind = 'fact', confidence = 0.9, validUntil: string | null = null) => ({
  content,
  kind,
  confidence,
  validUntil,
});

/** A realistic onboarding conversation: durable facts mixed with filler, pronouns, a relative date and a pasted secret. */
export const ONBOARDING_TRANSCRIPT = [
  { role: 'user', content: 'hey, quick one before my standup' },
  { role: 'assistant', content: 'Sure, what do you need?' },
  { role: 'user', content: "So I just moved to Seattle last month and started at Stripe. I'm a PM on the payments dashboard team." },
  { role: 'assistant', content: 'Congratulations on the move and the new role! How is it going?' },
  { role: 'user', content: "Good so far. My manager is Dana Whitfield, she's great. The team is six engineers and a designer." },
  { role: 'user', content: "We're rebuilding the dashboard backend. I pushed hard for Postgres over MongoDB, I just trust it more for payments data." },
  { role: 'assistant', content: 'Postgres is a strong choice for transactional data. Do you need help with the schema?' },
  { role: 'user', content: 'Maybe later. Oh, can you remind me about my dentist appointment tomorrow at 10am?' },
  { role: 'assistant', content: 'I will keep that in mind.' },
  { role: 'user', content: 'Also here is the staging key so you can look at the logs: sk-proj-Q7hT2mZx9LwR4vB8nK3pYc6D' },
  { role: 'assistant', content: 'Please avoid sharing keys in chat. Rotate that one.' },
  { role: 'user', content: 'ugh right, thanks. anyway gotta run, thanks!!' },
];

export const EVAL_CASES: EvalCase[] = [
  {
    name: 'real-transcript',
    summary: 'A real onboarding call yields atomic, self-contained, pronoun-free facts and nothing secret',
    steps: [{ add: { customId: 'onboarding-call', content: ONBOARDING_TRANSCRIPT, documentDate: '2026-03-10T09:00:00.000Z' } }, { settle: true }],
    mock: {
      extraction: [
        {
          candidates: [
            candidate('The user moved to Seattle in February 2026.'),
            candidate('The user works at Stripe as a product manager on the payments dashboard team.'),
            candidate("Dana Whitfield is the user's manager at Stripe."),
            candidate('The payments dashboard team at Stripe has six engineers and a designer.', 'fact', 0.85),
            candidate('The user prefers Postgres over MongoDB for payments data.', 'preference', 0.9),
            candidate('The user has a dentist appointment at 10am on 2026-03-11.', 'episode', 0.9, '2026-03-11T23:59:59Z'),
            // Screened out: a pronoun, a leaked key, and filler.
            candidate('She is great.', 'fact', 0.7),
            candidate('The staging key is sk-proj-Q7hT2mZx9LwR4vB8nK3pYc6D.', 'fact', 0.9),
            candidate('The user said thanks.', 'fact', 0.2),
          ],
        },
      ],
    },
    query: { text: 'Where does the user work?', tokenBudget: 200 },
    assertions: [
      { type: 'completion-calls', eq: 1 },
      { type: 'memory-count', min: 3, max: 12 },
      { type: 'memory-exists', matches: 'Stripe' },
      { type: 'memory-exists', matches: 'Seattle' },
      { type: 'memory-exists', matches: 'Postgres', kind: 'preference' },
      { type: 'no-unresolved-pronouns' },
      { type: 'no-secrets-persisted', secrets: ['sk-proj-Q7hT2mZx9LwR4vB8nK3pYc6D'] },
      { type: 'memory-absent', matches: '\\bthanks\\b' },
      { type: 'recall-includes', matches: 'Stripe', topK: 3 },
      { type: 'rejected', reason: 'unresolved-pronoun', mockOnly: true },
      { type: 'rejected', reason: 'secret', mockOnly: true },
      { type: 'rejected', reason: 'low-confidence', mockOnly: true },
    ],
  },
  {
    name: 'pronoun-resolution',
    summary: 'Every candidate names who and where; no unresolved pronouns survive',
    steps: [
      {
        add: {
          content: [
            { role: 'user', content: 'My sister Priya just moved to Lisbon. She loves it there.' },
            { role: 'user', content: 'Her husband Tomás works remotely for Shopify, so they could pick anywhere.' },
          ],
          extraction: 'instant',
        },
      },
      { settle: true },
    ],
    mock: {
      extraction: [
        {
          candidates: [
            candidate("Priya is the user's sister."),
            candidate('Priya moved to Lisbon in March 2026.'),
            candidate("Tomás is Priya's husband."),
            candidate('Tomás works remotely for Shopify.'),
            candidate('He works remotely for them.'),
          ],
        },
      ],
    },
    assertions: [
      { type: 'no-unresolved-pronouns' },
      { type: 'memory-exists', matches: 'Priya.*Lisbon' },
      { type: 'memory-exists', matches: 'Tomás.*Shopify' },
      { type: 'rejected', reason: 'unresolved-pronoun', mockOnly: true },
    ],
  },
  {
    name: 'noise-rejection',
    summary: 'A transcript of pure small talk produces zero memories',
    steps: [
      {
        add: {
          content: [
            { role: 'user', content: 'hiii' },
            { role: 'assistant', content: 'Hello! How can I help today?' },
            { role: 'user', content: 'nothing lol just bored. how are you' },
            { role: 'assistant', content: "I'm doing well, thanks for asking!" },
            { role: 'user', content: 'cool cool. ok thanks, bye' },
          ],
          extraction: 'instant',
        },
      },
      { settle: true },
    ],
    mock: { extraction: [{ candidates: [candidate('The user said hello and was bored.', 'episode', 0.3)] }] },
    assertions: [
      { type: 'memory-count', eq: 0 },
      { type: 'rejected', reason: 'low-confidence', mockOnly: true },
    ],
  },
  {
    name: 'secrets',
    summary: 'A transcript full of credentials leaves zero bytes of them in storage',
    steps: [{ add: { content: credentialTranscript(), extraction: 'instant' } }, { settle: true }],
    mock: {
      extraction: [
        {
          candidates: [
            candidate('The user prefers Postgres over MongoDB for the payments service.', 'preference'),
            candidate(`The user's AWS access key is ${CREDENTIAL_FIXTURES[1]}.`),
          ],
        },
      ],
    },
    assertions: [
      { type: 'no-secrets-persisted', secrets: CREDENTIAL_FIXTURES },
      { type: 'memory-exists', matches: 'Postgres' },
      { type: 'rejected', reason: 'secret', mockOnly: true },
    ],
  },
  {
    name: 'session-grouping',
    summary: 'A chat session sent turn by turn under one customId is extracted once',
    steps: [
      { add: { customId: 'chat-42', content: [{ role: 'user', content: 'I am planning a trip.' }] } },
      { advance: 8_000 },
      {
        add: {
          customId: 'chat-42',
          content: [
            { role: 'user', content: 'I am planning a trip.' },
            { role: 'user', content: 'It is to Kyoto, in April, with my partner Sam.' },
          ],
        },
      },
      { advance: 8_000 },
      {
        add: {
          customId: 'chat-42',
          content: [
            { role: 'user', content: 'I am planning a trip.' },
            { role: 'user', content: 'It is to Kyoto, in April, with my partner Sam.' },
            { role: 'user', content: 'Sam is vegetarian, so restaurant tips should be too.' },
          ],
        },
      },
      { settle: true },
    ],
    mock: {
      extraction: [
        {
          candidates: [
            candidate('The user is planning a trip to Kyoto in April 2026 with Sam.', 'episode'),
            candidate("Sam is the user's partner."),
            candidate('Sam is vegetarian.'),
          ],
        },
      ],
    },
    assertions: [
      { type: 'completion-calls', eq: 1 },
      { type: 'memory-exists', matches: 'Kyoto' },
      { type: 'memory-exists', matches: 'Sam.*vegetarian' },
      { type: 'no-unresolved-pronouns' },
    ],
  },
  {
    name: 'expiry',
    summary: 'A time-bound fact stops being served once the injected clock passes its validity',
    steps: [
      {
        add: {
          content: [{ role: 'user', content: 'I have a design review meeting at 3pm today, so I will be offline then.' }],
          extraction: 'instant',
          documentDate: '2026-03-10T09:00:00.000Z',
        },
      },
      { settle: true },
      { advance: 2 * 24 * 60 * 60_000 },
    ],
    mock: {
      extraction: [
        { candidates: [candidate('The user has a design review meeting at 3pm on 2026-03-10.', 'episode', 0.9, '2026-03-10T23:59:59Z')] },
      ],
    },
    query: { text: 'design review meeting' },
    assertions: [
      { type: 'memory-exists', matches: 'design review' },
      { type: 'recall-excludes', matches: 'design review', reason: 'expired' },
    ],
  },
  {
    name: 'precision-at-scale',
    summary: '1,000 irrelevant memories and 1 relevant one: the relevant one is in the top 5',
    steps: [
      {
        memories: Array.from({ length: 1000 }, (_, i) => ({
          content: `Note ${i}: the ${['red', 'blue', 'green', 'amber', 'violet'][i % 5]} ${['kettle', 'bicycle', 'lantern', 'notebook', 'umbrella', 'guitar'][i % 6]} is kept in the ${['garage', 'attic', 'hallway', 'basement', 'garden shed'][i % 5]}.`,
        })),
      },
      { memories: [{ content: 'Alex works at Stripe as a product manager.' }] },
    ],
    query: { text: 'Which company does Alex work at?' },
    assertions: [{ type: 'recall-includes', matches: 'Alex works at Stripe', topK: 5 }],
  },
  {
    name: 'contradiction',
    summary: 'Ingest A, then contradicting B: recall returns B, and A survives as not-latest',
    steps: [
      { add: { content: [{ role: 'user', content: 'Our payments service runs on Postgres.' }], extraction: 'instant' } },
      { settle: true },
      { advance: 7 * 24 * 60 * 60_000 },
      { add: { content: [{ role: 'user', content: 'We migrated the payments service from Postgres to MySQL this week.' }], extraction: 'instant' } },
      { settle: true },
    ],
    mock: {
      extraction: [
        { candidates: [candidate('The payments service of the user runs on Postgres.')] },
        { candidates: [candidate('The payments service of the user runs on MySQL, migrated from Postgres in March 2026.')] },
      ],
      resolution: [{ relation: 'updates', memoryId: 'm1', reason: 'The payments database changed from Postgres to MySQL.' }],
    },
    query: { text: 'What database does the payments service use?', tokenBudget: 200 },
    assertions: [
      { type: 'recall-includes', matches: 'MySQL' },
      { type: 'recall-excludes', matches: '^(?!.*MySQL).*Postgres', reason: 'not-latest' },
      { type: 'relation-exists', relation: 'updates', from: 'MySQL', to: '^(?!.*MySQL).*Postgres' },
      { type: 'memory-count', eq: 1, latestOnly: true },
    ],
  },
  {
    name: 'duplicate',
    summary: 'The same fact phrased twice becomes one memory reinforced twice',
    steps: [
      { add: { content: [{ role: 'user', content: 'I always use dark mode.' }], extraction: 'instant' } },
      { settle: true },
      { add: { content: [{ role: 'user', content: 'Dark mode is my preference in every editor.' }], extraction: 'instant' } },
      { settle: true },
    ],
    mock: {
      extraction: [
        { candidates: [candidate('The user prefers dark mode.', 'preference')] },
        { candidates: [candidate('The user prefers dark mode in every editor.', 'preference')] },
      ],
      resolution: [{ relation: 'duplicate', memoryId: 'm1', reason: 'Same preference, rephrased.' }],
    },
    assertions: [
      { type: 'memory-count', eq: 1, latestOnly: true },
      { type: 'memory-exists', matches: 'dark mode', minReinforcement: 2 },
    ],
  },
  {
    name: 'extends',
    summary: 'A role, then a team size: two latest memories joined by an extends edge',
    steps: [
      { add: { content: [{ role: 'user', content: 'I am a PM at Stripe.' }], extraction: 'instant' } },
      { settle: true },
      { add: { content: [{ role: 'user', content: 'At Stripe I manage a team of six engineers.' }], extraction: 'instant' } },
      { settle: true },
    ],
    mock: {
      extraction: [
        { candidates: [candidate('The user is a product manager at Stripe.')] },
        { candidates: [candidate('The user manages a team of six engineers at Stripe.')] },
      ],
      resolution: [{ relation: 'extends', memoryId: 'm1', reason: 'Adds the team size in the same role.' }],
    },
    assertions: [
      { type: 'memory-count', eq: 2, latestOnly: true },
      { type: 'relation-exists', relation: 'extends', from: 'six engineers', to: 'product manager' },
    ],
  },
  {
    name: 'session-growth',
    summary: 'A session re-sent with more turns reconciles with what was already extracted instead of duplicating it',
    steps: [
      {
        add: {
          customId: 'standup',
          content: [{ role: 'user', content: 'For payments data I really prefer Postgres over MongoDB.' }],
        },
      },
      { settle: true },
      { advance: 2 * 60 * 60_000 },
      {
        add: {
          customId: 'standup',
          content: [
            { role: 'user', content: 'For payments data I really prefer Postgres over MongoDB.' },
            { role: 'user', content: 'Like I said, Postgres beats MongoDB for anything with money in it. Also we are hiring a second designer.' },
          ],
        },
      },
      { settle: true },
    ],
    mock: {
      extraction: [
        { candidates: [candidate('The user prefers Postgres over MongoDB for payments data.', 'preference')] },
        {
          candidates: [
            candidate('The user prefers Postgres over MongoDB for financial data.', 'preference'),
            candidate('The team of the user is hiring a second designer.', 'fact', 0.8),
          ],
        },
      ],
      resolution: [{ relation: 'duplicate', memoryId: 'm1', reason: 'Same preference restated.' }],
    },
    assertions: [
      { type: 'completion-calls', eq: 2, kind: 'extraction' },
      { type: 'memory-exists', matches: 'Postgres over MongoDB', minReinforcement: 2 },
      { type: 'memory-exists', matches: 'second designer' },
      { type: 'memory-count', eq: 2, latestOnly: true },
    ],
  },
  {
    name: 'in-conversation-correction',
    summary: 'A fact corrected later in the same conversation is stored as superseded, not as two truths',
    steps: [
      {
        add: {
          content: [
            { role: 'user', content: 'I live in Portland.' },
            { role: 'assistant', content: 'Nice, how do you like it?' },
            { role: 'user', content: 'Oh wait, sorry, I moved to Seattle last month. Portland was before.' },
          ],
          extraction: 'instant',
        },
      },
      { settle: true },
    ],
    mock: {
      extraction: [
        {
          candidates: [
            candidate('The user lived in Portland.', 'fact', 0.7),
            candidate('The user lives in Seattle, having moved from Portland in February 2026.'),
          ],
        },
      ],
      resolution: [{ relation: 'updates', memoryId: 'm1', reason: 'The user moved from Portland to Seattle.' }],
    },
    query: { text: 'Which city does the user live in?' },
    assertions: [
      { type: 'recall-includes', matches: 'Seattle' },
      { type: 'memory-absent', matches: '^(?!.*Seattle).*Portland' },
      { type: 'relation-exists', relation: 'updates', from: 'Seattle', to: '^(?!.*Seattle).*Portland', mockOnly: true },
    ],
  },
  {
    name: 'profile-current',
    summary: 'The profile states what is true now: the new database, not the superseded one, and not a forgotten fact',
    steps: [
      { add: { content: [{ role: 'user', content: 'I work at Stripe. Our payments service runs on Postgres.' }], extraction: 'instant' } },
      { settle: true },
      { advance: 7 * 24 * 60 * 60_000 },
      { add: { content: [{ role: 'user', content: 'We migrated the payments service to MySQL this week.' }], extraction: 'instant' } },
      { settle: true },
    ],
    mock: {
      extraction: [
        {
          candidates: [
            candidate('The user works at Stripe.'),
            candidate('The payments service of the user runs on Postgres.'),
          ],
        },
        { candidates: [candidate('The payments service of the user runs on MySQL.')] },
      ],
      resolution: [{ relation: 'updates', memoryId: 'm1', reason: 'The payments database changed.' }],
    },
    assertions: [
      { type: 'profile-includes', matches: 'Stripe' },
      { type: 'profile-includes', matches: 'MySQL' },
      { type: 'profile-excludes', matches: 'Postgres' },
    ],
  },
  {
    name: 'semantic-recall',
    summary: 'A question worded differently from the memory is answered through embeddings, not shared words',
    liveOnly: true,
    steps: [
      {
        memories: [
          { content: 'The user is employed by Figma as a senior product designer.' },
          { content: 'The user keeps a sourdough starter named Clint.' },
          { content: 'The user runs 10k races most weekends.' },
          { content: 'The payments team meets every Tuesday.' },
        ],
      },
    ],
    query: { text: 'Where does the user work?' },
    assertions: [{ type: 'recall-includes', matches: 'Figma', topK: 2 }],
  },
];