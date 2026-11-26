import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

console.log('=== DecorBiz Security Audit (Secrets Scan + Dependency Audit) ===');

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'api', 'scripts', 'public', 'supabase/migrations', 'tests'];
const SCAN_FILES = ['server.ts', '.env.example', 'vercel.json', 'index.html', 'erp.html', 'package.json'];
const ALLOWED_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.sql',
  '.html',
  '.txt',
  '.css',
  '.example',
]);

const SECRET_PATTERNS = [
  { name: 'Google/Gemini API Key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'OpenAI/Anthropic Secret Key', regex: /\bsk-(?:live|proj|ant-api03)-[0-9A-Za-z_-]{20,}\b/g },
  { name: 'Razorpay Live Key/Secret', regex: /\brzp_live_[0-9A-Za-z]{14,}\b/g },
  { name: 'Supabase Personal Access Token', regex: /\bsbp_[0-9A-Za-z]{20,}\b/g },
  { name: 'GitHub PAT', regex: /\b(?:ghp_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{30,})\b/g },
  { name: 'Private Key PEM Block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |PRIVATE )?PRIVATE KEY-----/g },
  {
    name: 'Hardcoded Real JWT Token',
    regex: /\beyJ[A-Za-z0-9_-]{24,}\.eyJ[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: 'Client-Exposed Server Secret (VITE_*)',
    regex: /\bVITE_[A-Z0-9_]*(?:SERVICE_ROLE|ENCRYPTION_KEY|KEY_SECRET|ACCESS_TOKEN|BREAKGLASS_TOKEN|CLIENT_SECRET)\b/g,
  },
];

function collectFiles() {
  const out = [];
  for (const rel of SCAN_FILES) {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs)) out.push(rel);
  }
  const walk = (dirRel) => {
    const absDir = path.join(ROOT, dirRel);
    if (!fs.existsSync(absDir)) return;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const relPath = path.join(dirRel, entry.name);
      if (entry.isDirectory()) {
        walk(relPath);
      } else if (ALLOWED_EXTS.has(path.extname(entry.name)) || entry.name === '.env.example') {
        out.push(relPath);
      }
    }
  };
  for (const d of SCAN_DIRS) walk(d);
  return out;
}

export function runSecretsScan() {
  const files = collectFiles();
  const findings = [];

  for (const relPath of files) {
    const abs = path.join(ROOT, relPath);
    const content = fs.readFileSync(abs, 'utf8');
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pat of SECRET_PATTERNS) {
        pat.regex.lastIndex = 0;
        let match;
        while ((match = pat.regex.exec(line)) !== null) {
          const val = match[0];
          // Ignore explicit test-only fake tokens in tests/ when clearly synthetic or security-audit itself
          if (relPath === 'scripts/security-audit.mjs') continue;
          if (relPath.startsWith('tests/') && /dummy|fake|test|example/i.test(line)) continue;
          findings.push({
            file: relPath,
            line: i + 1,
            rule: pat.name,
            preview: val.slice(0, 14) + '...',
          });
        }
      }
    }
  }

  return { scannedFiles: files.length, findings };
}

export function runDependencyAudit() {
  const hasBunLock = fs.existsSync(path.join(ROOT, 'bun.lock'));
  let tool = 'bun';
  let proc = hasBunLock
    ? spawnSync('bun', ['audit'], { encoding: 'utf8', cwd: ROOT })
    : spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', cwd: ROOT });

  if (proc.error) {
    tool = 'npm';
    proc = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', cwd: ROOT });
  }

  const combined = `${proc.stdout || ''}\n${proc.stderr || ''}`.trim();
  const counts = { critical: 0, high: 0, moderate: 0, low: 0 };

  if (tool === 'npm' && combined.startsWith('{')) {
    try {
      const json = JSON.parse(combined);
      const vulns = json?.metadata?.vulnerabilities || {};
      counts.critical = Number(vulns.critical || 0);
      counts.high = Number(vulns.high || 0);
      counts.moderate = Number(vulns.moderate || 0);
      counts.low = Number(vulns.low || 0);
    } catch {
      // Fallback below
    }
  } else {
    for (const level of ['critical', 'high', 'moderate', 'low']) {
      const matches = combined.match(new RegExp(`^${level}\\s*:`, 'gim'));
      if (matches) counts[level] = matches.length;
    }
    const summaryMatch = combined.match(/(\d+)\s+vulnerabilit/i);
    if (
      summaryMatch &&
      counts.critical + counts.high + counts.moderate + counts.low === 0
    ) {
      counts.moderate = Number(summaryMatch[1]);
    }
  }

  return {
    tool,
    exitCode: proc.status ?? 0,
    counts,
    rawOutput: combined,
  };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const secretResult = runSecretsScan();
  console.log(
    `[secrets-scan] Scanned ${secretResult.scannedFiles} files -> ${secretResult.findings.length} finding(s).`
  );
  if (secretResult.findings.length > 0) {
    for (const f of secretResult.findings) {
      console.error(`  FAIL ${f.file}:${f.line} [${f.rule}] (${f.preview})`);
    }
    process.exit(1);
  }

  const auditResult = runDependencyAudit();
  console.log(
    `[dependency-audit] (${auditResult.tool}) critical=${auditResult.counts.critical}, high=${auditResult.counts.high}, moderate=${auditResult.counts.moderate}, low=${auditResult.counts.low}`
  );
  if (auditResult.counts.critical > 0 || auditResult.counts.high > 0) {
    console.error('[dependency-audit] FAILURE: High or critical severity vulnerabilities detected:');
    console.error(auditResult.rawOutput);
    process.exit(1);
  }

  console.log('[security-audit] PASSED (0 leaked secrets, 0 high/critical vulnerabilities).');
}
