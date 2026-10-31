// report.js — builds the Markdown "life report" from every module's exportForAI.
// Used by the AI coach (as context) and by Settings → "Copy life report for any AI".
import { dates } from './ui.js';

export async function buildLifeReport(ctx, { days = 90 } = {}) {
  const { settings, modules } = ctx;
  const since = dates.addDays(dates.today(), -days);
  const parts = [
    `# Life report for ${settings.get('name') || 'me'}`,
    `Generated ${new Date().toLocaleString()}. Covers the last ${days} days (since ${since}). Today is ${dates.today()}. Units: ${settings.get('units', 'kg')}, currency ${settings.get('currency', 'USD')}.`,
  ];
  for (const m of modules) {
    if (!m.exportForAI) continue;
    try {
      const s = await m.exportForAI(ctx, { since, days });
      if (!s || !s.trim()) continue;
      const body = s.trim();
      // Modules may start with their own "## Heading" line — keep theirs instead of adding a duplicate.
      parts.push(/^##\s/.test(body) ? '\n' + body : `\n## ${m.title}\n${body}`);
    } catch (e) { console.error('exportForAI failed', m.id, e); }
  }
  return parts.join('\n');
}
