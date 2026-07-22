import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(__dirname, '..');
const ALLOWED_JWT_VERIFY_FILES = new Set([
  path.join(SRC_ROOT, 'server', 'auth', 'validator.ts'),
  path.join(SRC_ROOT, 'server', 'auth', 'jwt_verifier.ts'),
  path.join(SRC_ROOT, 'server', 'auth', 'dpop.ts'),
]);

function listSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    if (entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

function parseFile(filename: string): ts.SourceFile {
  const contents = fs.readFileSync(filename, 'utf8');
  return ts.createSourceFile(filename, contents, ts.ScriptTarget.ES2022, true);
}

type Finding = { file: string; line: number; column: number; message: string };

function recordFinding(findings: Finding[], file: string, node: ts.Node, message: string): void {
  const source = node.getSourceFile();
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart());
  findings.push({ file, line: line + 1, column: character + 1, message });
}

function scanForGuardrails(files: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const source = parseFile(file);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node)) {
        const name = node.name.text;
        if (name === 'claims' || name === 'tokenClaims') {
          recordFinding(findings, file, node, `Forbidden property access ".${name}".`);
        }
      }
      if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
        const name = node.argumentExpression.text;
        if (name === 'claims' || name === 'tokenClaims') {
          recordFinding(findings, file, node, `Forbidden element access "['${name}']".`);
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === 'jwtVerify' && !ALLOWED_JWT_VERIFY_FILES.has(file)) {
          recordFinding(
            findings,
            file,
            node,
            'jwtVerify must only be used in auth/validator.ts, auth/jwt_verifier.ts, or auth/dpop.ts.',
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return findings;
}

describe('auth guardrails', () => {
  it('prevents claims access and limits jwtVerify usage', () => {
    const files = listSourceFiles(SRC_ROOT);
    const findings = scanForGuardrails(files);
    if (findings.length > 0) {
      const message = findings
        .map((finding) => `${finding.file}:${finding.line}:${finding.column} ${finding.message}`)
        .join('\n');
      expect(message).toBe('');
    }
    expect(findings).toEqual([]);
  });
});
