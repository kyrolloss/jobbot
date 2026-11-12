import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH } from '../src/config.js';
import { createDefaultSources, runScan } from '../src/scanner.js';
import { extractTags } from '../src/tech.js';

const nodeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = path.join(nodeDir, 'docs', 'step11_report.md');
const pythonDbPath = resolvePythonDbPath();
const SOURCE_LABELS = Object.freeze({ freelancer: 'Freelancer', mostaql: 'Mostaql', khamsat: 'Khamsat' });

function resolvePythonDbPath() {
  const configured = process.env.PYTHON_DB_PATH || '../jobs.db';
  return path.isAbsolute(configured) ? configured : path.resolve(nodeDir, configured);
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info("${String(table).replaceAll('"', '""')}")`).all().map((row) => row.name));
}

function selectColumn(available, names, fallback = 'NULL') {
  const name = names.find((candidate) => available.has(candidate));
  return name ? `"${name}"` : fallback;
}

function listPythonJobs(db) {
  const available = columns(db, 'jobs');
  if (!available.size) throw new Error('Python database has no jobs table');
  const id = selectColumn(available, ['id'], 'rowid');
  const tags = selectColumn(available, ['tech_tags', 'tags']);
  const select = `SELECT ${id} AS id,title,url,source,score,${tags} AS tech_tags,created_at
    FROM jobs WHERE datetime(created_at)>=datetime('now','-48 hours')`;
  return db.prepare(select).all().map((row) => ({ ...row, id: Number(row.id) }));
}

function getStoredNodeJob(db, source, externalId) {
  return db.prepare('SELECT rowid AS id,score,tags FROM jobs WHERE source=? AND external_id=?').get(source, externalId);
}

function normalizeUrl(value) { return typeof value === 'string' ? value.trim() : ''; }
function sourceUrlKey(source, url) { return `${source}\n${normalizeUrl(url)}`; }

function parseTags(value) {
  if (Array.isArray(value)) return value.filter((tag) => typeof tag === 'string').map((tag) => tag.trim()).sort();
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((tag) => typeof tag === 'string')
      ? parsed.map((tag) => tag.trim()).sort()
      : null;
  } catch { return null; }
}

function matchesByUrl(pythonJobs, nodeJobs) {
  const nodeByUrl = new Map();
  for (const job of nodeJobs) {
    const url = normalizeUrl(job.url);
    if (url && !nodeByUrl.has(url)) nodeByUrl.set(url, job);
  }
  const pythonUrls = new Set(pythonJobs.map((job) => normalizeUrl(job.url)).filter(Boolean));
  const matched = [];
  const onlyPython = [];
  for (const job of pythonJobs) {
    const url = normalizeUrl(job.url);
    const nodeJob = url ? nodeByUrl.get(url) : null;
    if (nodeJob) matched.push({ python: job, node: nodeJob });
    else onlyPython.push(job);
  }
  const onlyNode = nodeJobs.filter((job) => {
    const url = normalizeUrl(job.url);
    return !url || !pythonUrls.has(url);
  });
  return { matched, onlyPython, onlyNode };
}

function scoreStats(matched) {
  const diffs = matched.flatMap(({ python, node }) => {
    const pythonScore = Number(python.score), nodeScore = Number(node.score);
    return python.score != null && node.score != null && Number.isFinite(pythonScore) && Number.isFinite(nodeScore)
      ? [Math.abs(pythonScore - nodeScore)] : [];
  });
  const tagPairs = matched.flatMap(({ python, node }) => {
    const pythonTags = parseTags(python.tech_tags), nodeTags = parseTags(node.tech_tags);
    return pythonTags && nodeTags ? [[pythonTags, nodeTags]] : [];
  });
  const tagMatches = tagPairs.filter(([pythonTags, nodeTags]) => JSON.stringify(pythonTags) === JSON.stringify(nodeTags)).length;
  return {
    average: diffs.length ? diffs.reduce((sum, diff) => sum + diff, 0) / diffs.length : null,
    maximum: diffs.length ? Math.max(...diffs) : null,
    comparedScores: diffs.length,
    tagRate: tagPairs.length ? tagMatches / tagPairs.length : null,
    comparedTags: tagPairs.length,
  };
}

function countsBySource(jobs) {
  return Object.fromEntries(Object.keys(SOURCE_LABELS).map((source) => [source, jobs.filter((job) => job.source === source).length]));
}

function formatNumber(value) { return Number.isFinite(value) ? value.toFixed(2) : 'N/A'; }

function makeReport({ pythonJobs, nodeJobs, matches, scoreStats: scores, scan, failure = null }) {
  const pythonCounts = countsBySource(pythonJobs), nodeCounts = countsBySource(nodeJobs);
  const totalPython = pythonJobs.length, totalNode = nodeJobs.length;
  const pythonMissRate = totalPython ? matches.onlyPython.length / totalPython : 0;
  const nodeMissRate = totalNode ? matches.onlyNode.length / totalNode : 0;
  const reasons = [];
  if (pythonMissRate > 0.20) reasons.push(`Python miss rate ${(pythonMissRate * 100).toFixed(1)}% exceeds 20%`);
  if (nodeMissRate > 0.20) reasons.push(`Node miss rate ${(nodeMissRate * 100).toFixed(1)}% exceeds 20%`);
  if (scores.average === null) reasons.push('no matched score pairs are available');
  else if (scores.average > 1.0) reasons.push(`average score difference ${scores.average.toFixed(2)} exceeds 1.00`);
  if (failure) reasons.push(failure);

  const lines = [
    '=== Step 11 Parity Report ===',
    `Generated: ${new Date().toISOString()}`,
    '',
    '[Sources]',
    ...Object.entries(SOURCE_LABELS).map(([key, label]) => `  ${label.padEnd(10)} — Python: ${pythonCounts[key]}  Node: ${nodeCounts[key]}  Diff: ${nodeCounts[key] - pythonCounts[key]}`),
    `  ${'Total'.padEnd(10)} — Python: ${totalPython}  Node: ${totalNode}  Diff: ${totalNode - totalPython}`,
    '',
    `[Matched Jobs: ${matches.matched.length} of ${totalPython}]`,
    `  Avg score diff : ${formatNumber(scores.average)}`,
    `  Max score diff : ${formatNumber(scores.maximum)}`,
    `  Tag match rate : ${scores.tagRate === null ? 'N/A' : `${(scores.tagRate * 100).toFixed(1)}%`}`,
    '',
    `[Only in Python: ${matches.onlyPython.length} jobs]`,
    ...(matches.onlyPython.length ? matches.onlyPython.map((job) => `  ${job.url || '(no URL)'} | ${job.title || ''} | score: ${job.score ?? 'N/A'}`) : ['  (none)']),
    '',
    `[Only in Node: ${matches.onlyNode.length} jobs]`,
    ...(matches.onlyNode.length ? matches.onlyNode.map((job) => `  ${job.url || '(no URL)'} | ${job.title || ''} | score: ${job.score ?? 'N/A'}`) : ['  (none)']),
    '',
    '[Verdict]',
    ...(reasons.length
      ? [`  FAIL — ${reasons.join('; ')}`]
      : ['  PASS — differences are within acceptable range (<=20% miss rate, avg score diff <=1.0)']),
  ];
  if (scan) lines.push('', `[Node scan] ${scan.totals.fetched} fetched; ${scan.totals.new_saved} saved; ${scan.totals.errors} errors.`);
  return { text: `${lines.join('\n')}\n`, passed: reasons.length === 0 };
}

function writeReport(text) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, text, 'utf8');
}

async function main() {
  let pythonDb, nodeDb;
  let pythonJobs = [], nodeJobs = [], scan = null, failure = null;
  const fetchedBySource = new Map();
  const processedByUrl = new Map();
  try {
    pythonDb = new DatabaseSync(pythonDbPath, { readOnly: true });
    pythonJobs = listPythonJobs(pythonDb);
  } catch (error) {
    failure = `Python database could not be read (${error.code || error.name || 'error'})`;
  }
  try {
    if (!failure) {
      nodeDb = new DatabaseSync(DB_PATH, { readOnly: true });
      const sources = createDefaultSources();
      for (const source of sources) {
        const fetchJobs = source.fetchJobs.bind(source);
        source.fetchJobs = async (...args) => {
          const response = await fetchJobs(...args);
          const jobs = Array.isArray(response) ? response : response?.jobs || [];
          fetchedBySource.set(source.name, jobs);
          return response;
        };
      }
      scan = await runScan({
        db: nodeDb,
        sources,
        trigger: 'step11-parity',
        dryRun: true,
        onNewJob(job) {
          const url = normalizeUrl(job.url);
          if (url) processedByUrl.set(sourceUrlKey(job.source, url), job);
        },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      });
      nodeJobs = [];
      for (const source of sources) {
        for (const rawJob of fetchedBySource.get(source.name) || []) {
          const url = normalizeUrl(rawJob.url);
          const processed = url ? processedByUrl.get(sourceUrlKey(source.name, url)) : null;
          const stored = rawJob.external_id == null ? null : getStoredNodeJob(nodeDb, source.name, rawJob.external_id);
          const job = processed || rawJob;
          nodeJobs.push({
            id: stored ? Number(stored.id) : null,
            title: job.title || rawJob.title || '',
            url: rawJob.url || job.url || '',
            source: source.name,
            score: processed?.score ?? stored?.score ?? null,
            tech_tags: JSON.stringify(extractTags(job)),
          });
        }
      }
    }
  } catch (error) {
    failure = `Node scan or result query failed (${error.code || error.name || 'error'})`;
  }

  if (pythonDb) { try { pythonDb.close(); } catch {} }
  if (nodeDb) { try { nodeDb.close(); } catch {} }

  const matches = matchesByUrl(pythonJobs, nodeJobs);
  const report = makeReport({ pythonJobs, nodeJobs, matches, scoreStats: scoreStats(matches.matched), scan, failure });
  console.log(report.text);
  try { writeReport(report.text); }
  catch (error) {
    console.error(`Could not write report file (${error.code || error.name || 'error'}).`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = report.passed ? 0 : 1;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) void main();
