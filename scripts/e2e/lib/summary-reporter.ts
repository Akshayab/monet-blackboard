// Writes scripts/e2e/.report/summary.md: pass/fail counts and one row per test, with skip/fixme notes
// and findings. The JSON and HTML reports sit next to it.
import fs from 'node:fs';
import path from 'node:path';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { BASE_URL, IS_LOCAL_DEV, REPORT_DIR } from './env';

interface Row {
  file: string;
  title: string;
  project: string;
  status: string;
  durationMs: number;
  notes: string[];
}

const ICON: Record<string, string> = {
  passed: 'pass',
  failed: 'FAIL',
  timedOut: 'FAIL (timeout)',
  skipped: 'skip',
  interrupted: 'interrupted',
  flaky: 'flaky',
  fixme: 'fixme',
};

export default class SummaryReporter implements Reporter {
  private rows = new Map<string, Row>();
  private started = new Date();

  onTestEnd(test: TestCase, result: TestResult) {
    const annotations = test.annotations;
    const isFixme = annotations.some((a) => a.type === 'fixme');
    const outcome = test.outcome();
    const status = isFixme && result.status === 'skipped' ? 'fixme' : outcome === 'flaky' ? 'flaky' : result.status;
    const notes = annotations.filter((a) => a.description).map((a) => `${a.type}: ${a.description}`);
    if (result.error?.message && (result.status === 'failed' || result.status === 'timedOut')) {
      notes.push(`error: ${stripAnsi(result.error.message).split('\n').slice(0, 3).join(' ').slice(0, 300)}`);
    }
    const [, , file, ...rest] = test.titlePath();
    this.rows.set(test.id, {
      file: file ?? '',
      title: rest.join(' › '),
      project: test.parent.project()?.name ?? '',
      status,
      durationMs: result.duration,
      notes,
    });
  }

  onEnd(result: FullResult) {
    const rows = [...this.rows.values()].sort((a, b) => a.file.localeCompare(b.file));
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    const failed = rows.filter((r) => r.status === 'failed' || r.status === 'timedOut' || r.status === 'interrupted').length;
    const lines = [
      '# Monet Blackboard end-to-end results',
      '',
      `- Run: ${this.started.toISOString()} against \`${BASE_URL}\`${IS_LOCAL_DEV ? ' (database seeding on)' : ''}`,
      `- Overall: **${result.status}**`,
      `- Tests: ${rows.length} · passed ${count('passed')} · failed ${failed} · flaky ${count('flaky')} · skipped ${count('skipped')} · fixme ${count('fixme')}`,
      '- Full reports: `results.json` (machine-readable) and `html/index.html` (screenshots attached to each test).',
      '- Re-run: `pnpm --filter @monet/scripts run e2e` (API-only protocol checks: `run e2e:api`).',
      '',
      '| Spec | Test | Result | Time | Notes |',
      '|---|---|---|---|---|',
      ...rows.map(
        (r) => `| ${r.file} | ${escape(r.title)} | ${ICON[r.status] ?? r.status} | ${(r.durationMs / 1000).toFixed(1)}s | ${escape(r.notes.join('; '))} |`,
      ),
      '',
    ];
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, 'summary.md'), lines.join('\n'));
  }

  printsToStdio() {
    return false;
  }
}

function escape(s: string) {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function stripAnsi(s: string) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}
