// Recorded evidence, with the comparison boundary visible beside the numbers.
// This replaces hypothetical cost projections with a reproducible local result.
export function renderBenchmarkEvidence() {
  return `  <section id="savings" class="showcase">
    <h2>05 — Measured evidence</h2>
    <p class="section-title">Check the result against your workflow</p>
    <p class="section-sub">Recorded October 24, 2026: ten trials per path on one local checkout. Both paths verified the saved order through an independent server check. No LLM planner was used.</p>
    <div class="benchmark-table-wrap">
      <table>
        <caption>Local checkout benchmark · observation tokens, not billed LLM usage</caption>
        <thead><tr><th>Execution path</th><th>Correct orders</th><th>Mean context tokens / task</th><th>Mean time / task</th></tr></thead>
        <tbody>
          <tr><td>Playwright role locators + explicit waits</td><td>10 / 10</td><td>1,026.1</td><td>1.975 s</td></tr>
          <tr><td>Navi MCP + optional settlement</td><td>10 / 10</td><td>972.3</td><td>1.764 s</td></tr>
        </tbody>
      </table>
    </div>
    <p class="muted">In this fixture Navi's planner observations used about 5% fewer tokens than the Playwright snapshots, after Navi switched to compact maps. The Playwright path included 300 ms waits after non-navigation actions. These results do not establish general speed, reliability, or cost savings.</p>
    <p class="muted">A separate 100-mutation fixture recorded 96.9% fewer estimated tokens for differential updates than repeatedly sending Navi's own full map. That comparison is not against another agent product.</p>
    <p><a href="https://github.com/Wub796/Navi/blob/main/reports/TCR-BENCHMARK.md">Checkout methodology &amp; raw results &nearr;</a> · <a href="https://github.com/Wub796/Navi/blob/main/reports/differential-mutations.json">Differential fixture &nearr;</a></p>

    <div class="live-benchmark">
      <h3>Live-model hard-checkout comparison</h3>
      <p class="muted">40 matched pairs per model (120 pairs, 240 path runs total) on one local checkout fixture. Each pass required an independent saved-order check; the task included a delayed shipping quote and an initial rejected submission. This is stronger evidence than a scripted demo, but it is not a customer-site benchmark.</p>
      <div class="benchmark-table-wrap">
        <table>
          <caption>Tool-calling models · completed orders · Navi minus Playwright</caption>
          <thead><tr><th>Model</th><th>Navi</th><th>Playwright</th><th>Paired difference · 95% bootstrap interval</th><th>Interpretation</th></tr></thead>
          <tbody>
            <tr><td>beam</td><td>34 / 40 · 85%</td><td>39 / 40 · 97.5%</td><td>−12.5 pp · [−25, 0]</td><td>Inconclusive · Playwright higher in this sample</td></tr>
            <tr><td>gemma4:31b</td><td>40 / 40 · 100%</td><td>38 / 40 · 95%</td><td>+5 pp · [0, 12.5]</td><td>Not worse within the pre-set 10-point margin</td></tr>
            <tr><td>gpt-oss:20b</td><td>21 / 40 · 52.5%</td><td>5 / 40 · 12.5%</td><td>+40 pp · [22.5, 57.5]</td><td>Superior on this task · McNemar p=0.000402</td></tr>
          </tbody>
        </table>
      </div>
      <p class="muted">Results vary by model: Beam shows a numerical Navi deficit, but the paired test is not significant (p=0.125); gpt-oss completed only 21/40 Navi trials. One endpoint error was retained. Provider-billed cost was not reported, and no customer workflow was tested; do not infer general reliability or savings.</p>
      <p><a href="https://github.com/Wub796/Navi/blob/main/reports/LLM-TCR-BENCHMARK-MULTI.md">Study method and per-model reports &nearr;</a> · <a href="https://github.com/Wub796/Navi/blob/main/docs/FIRST-PAID-PILOT.md">Proposed paid pilot evaluation &nearr;</a></p>
    </div>
  </section>`;
}

export const BENCHMARK_STYLE = `
    .benchmark-table-wrap { overflow-x: auto; }
    .benchmark-table-wrap table { min-width: 590px; font-variant-numeric: tabular-nums; }
    .benchmark-table-wrap caption { text-align: left; color: var(--muted); padding-bottom: 1rem; }
    .live-benchmark { border-top: 1px solid var(--line); margin-top: 2rem; padding-top: 1.5rem; }
    .live-benchmark h3 { font-size: 1rem; letter-spacing: -.02em; margin: 0 0 .6rem; }
    .live-benchmark td:last-child { min-width: 13rem; }
`;
