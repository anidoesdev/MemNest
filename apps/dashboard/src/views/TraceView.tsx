import type { TraceRow, Workspace } from '@memnest/ui-core';
import { useController } from '@memnest/ui-react';
import { Fragment, useEffect, useState } from 'react';
import { EmptyState, ErrorNote, KindDot } from '../components';
import { EXCLUDED_LABEL, formatNumber } from '../format';

const score = (value: number | undefined, digits = 4) => (value === undefined ? '—' : value.toFixed(digits));

/** Every candidate as a row: lexical rank, vector rank, fused score, included or why not, token cost, and the budget line. */
export function TraceView({ workspace }: { workspace: Workspace }) {
  const { trace } = workspace;
  const state = useController(trace);
  const { memoryId } = useController(workspace.selection);
  const { response, rows, budgetLine } = state;
  const included = rows.filter((r) => r.included).length;
  // The field holds what is typed; only a valid budget reaches the controller.
  const [budgetDraft, setBudgetDraft] = useState(String(state.tokenBudget));
  useEffect(() => setBudgetDraft(String(state.tokenBudget)), [state.tokenBudget]);

  return (
    <div className="trace-view">
      <form
        className="filters"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void trace.run();
        }}
      >
        <input type="search" aria-label="Query" placeholder="Ask what an agent would ask, e.g. what database does this user use?" value={state.query} onChange={(e) => trace.setQuery(e.target.value)} />
        <label className="field inline">
          <span>Token budget</span>
          <input
            type="number"
            min={1}
            step={1}
            value={budgetDraft}
            onChange={(e) => {
              setBudgetDraft(e.target.value);
              const tokens = Number(e.target.value);
              if (Number.isInteger(tokens) && tokens >= 1) trace.setTokenBudget(tokens);
            }}
            onBlur={() => setBudgetDraft(String(state.tokenBudget))}
          />
        </label>
        <button className="button primary" type="submit" disabled={!state.query.trim() || state.status === 'loading'}>
          {state.status === 'loading' ? 'Running…' : 'Run'}
        </button>
      </form>
      <ErrorNote message={state.error} />

      {!response && state.status !== 'loading' && (
        <EmptyState title="Run a query to see how recall decided">
          Each candidate memory is listed with where the lexical and vector retrievers ranked it, its fused score, its token cost, and whether it made it into the
          budget — or why it did not.
        </EmptyState>
      )}

      {response && (
        <div className={state.status === 'loading' ? 'refreshing' : ''}>
          <dl className="stats">
            <div>
              <dt>Included</dt>
              <dd>
                {included} of {rows.length}
              </dd>
            </div>
            <div>
              <dt>Budget used</dt>
              <dd>
                {formatNumber(response.trace.budget.used)} / {formatNumber(response.trace.budget.limit)}
              </dd>
            </div>
            <div>
              <dt>Chunks</dt>
              <dd>
                {response.chunks.length} · {formatNumber(state.chunkTokens)} tokens
              </dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd>{formatNumber(response.trace.timings.total ?? 0)} ms</dd>
            </div>
          </dl>
          {response.trace.degraded && (
            <p className="banner" role="status">
              Degraded: {response.trace.degraded}
            </p>
          )}
          <div className="table-scroll">
            <table className="trace-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Memory</th>
                  <th scope="col" className="num">
                    Lexical
                  </th>
                  <th scope="col" className="num">
                    Vector
                  </th>
                  <th scope="col" className="num">
                    Fused
                  </th>
                  {rows.some((r) => r.rerankScore !== undefined) && (
                    <th scope="col" className="num">
                      Rerank
                    </th>
                  )}
                  <th scope="col" className="num">
                    Tokens
                  </th>
                  <th scope="col">Budget</th>
                  <th scope="col">Decision</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <Fragment key={row.memoryId}>
                    {index === budgetLine && (
                      <tr className="budget-line" aria-label="Budget limit">
                        <td colSpan={9}>
                          <span>Budget of {formatNumber(response.trace.budget.limit)} tokens reached — candidates below did not fit</span>
                        </td>
                      </tr>
                    )}
                    <Row
                      row={row}
                      index={index}
                      limit={response.trace.budget.limit}
                      showRerank={rows.some((r) => r.rerankScore !== undefined)}
                      selected={row.memoryId === memoryId}
                      onSelect={() => workspace.select(row.memoryId)}
                    />
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && <p className="muted pad">No memory matched this query.</p>}
        </div>
      )}
    </div>
  );
}

function Row({ row, index, limit, showRerank, selected, onSelect }: { row: TraceRow; index: number; limit: number; showRerank: boolean; selected: boolean; onSelect: () => void }) {
  const share = Math.min(1, row.cumulativeTokens / Math.max(limit, 1));
  return (
    <tr className={`${row.included ? 'included' : 'excluded'} ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <td className="num muted">{index + 1}</td>
      <td className="memory-cell">
        <button className="link" onClick={onSelect}>
          {row.kind && <KindDot kind={row.kind} />}
          <span>{row.content ?? <em className="muted">{row.memoryId} (no longer available)</em>}</span>
        </button>
      </td>
      <td className="num">{row.lexicalRank ?? '—'}</td>
      <td className="num">{row.vectorRank ?? '—'}</td>
      <td className="num">{score(row.rrfScore)}</td>
      {showRerank && <td className="num">{score(row.rerankScore, 2)}</td>}
      <td className="num">{formatNumber(row.tokens)}</td>
      <td>
        {row.included && (
          <span className="meter" title={`${formatNumber(row.cumulativeTokens)} of ${formatNumber(limit)} tokens used after this memory`}>
            <span style={{ width: `${share * 100}%` }} />
          </span>
        )}
      </td>
      <td>
        {row.included ? <span className="decision included">Included</span> : <span className="decision excluded">{EXCLUDED_LABEL[row.excludedReason!]}</span>}
      </td>
    </tr>
  );
}
