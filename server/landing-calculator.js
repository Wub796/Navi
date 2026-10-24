// Recorded evidence, with the comparison boundary visible beside the numbers.
// This replaces hypothetical cost projections with a reproducible local result.
export function renderBenchmarkEvidence() {
  return `  <section id="savings" class="showcase">
    <h2>05 — Measured evidence</h2>
    <p class="section-title">Check the result against your workflow</p>
    <p class="section-sub">Recorded October 20, 2026: ten trials per path on one local checkout. Both paths verified the saved order through an independent server check. No LLM planner was used.</p>
    <div class="benchmark-table-wrap">
      <table>
        <caption>Local checkout benchmark · observation tokens, not billed LLM usage</caption>
        <thead><tr><th>Execution path</th><th>Correct orders</th><th>Mean context tokens / task</th><th>Mean time / task</th></tr></thead>
        <tbody>
          <tr><td>Playwright role locators + explicit waits</td><td>10 / 10</td><td>1,025.7</td><td>1.968 s</td></tr>
          <tr><td>Navi MCP + optional settlement</td><td>10 / 10</td><td>2,890.2</td><td>1.772 s</td></tr>
        </tbody>
      </table>
    </div>
    <p class="muted">Navi used more observation tokens in this fixture. The Playwright path included 300 ms waits after non-navigation actions. These results do not establish general speed, reliability, or cost savings.</p>
    <p class="muted">A separate 100-mutation fixture recorded 96.9% fewer estimated tokens for differential updates than repeatedly sending Navi's own full map. That comparison is not against another agent product.</p>
    <p><a href="https://github.com/Wub796/Navi/blob/main/reports/TCR-BENCHMARK.md">Checkout methodology &amp; raw results &nearr;</a> · <a href="https://github.com/Wub796/Navi/blob/main/reports/differential-mutations.json">Differential fixture &nearr;</a></p>
  </section>`;
}

export const BENCHMARK_STYLE = `
    .benchmark-table-wrap { overflow-x: auto; }
    .benchmark-table-wrap table { min-width: 590px; font-variant-numeric: tabular-nums; }
    .benchmark-table-wrap caption { text-align: left; color: var(--muted); padding-bottom: 1rem; }
`;
