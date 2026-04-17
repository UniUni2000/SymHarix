/**
 * HANDOVER.md Generation
 * DEV Agent creates this when completing development
 */

import type { Issue } from '../types';

export interface HandoverData {
  issueId: string;
  summary: string;
  changedFiles: string[];
  testStatus: {
    unitTests: 'PASS' | 'FAIL' | 'N/A';
    integrationTests: 'PASS' | 'FAIL' | 'N/A';
    coverage?: string;
  };
  knownIssues: string[];
}

export interface ParsedHandover {
  summary: string;
  changedFiles: string[];
  testStatus: {
    unitTests: string;
    integrationTests: string;
    coverage?: string;
  };
  knownIssues: string[];
}

/**
 * Build HANDOVER.md content from data
 */
export function buildHandoverContent(issue: Issue, data: HandoverData): string {
  const timestamp = new Date().toISOString();

  return `# Handover: ${issue.identifier}

## 开发摘要
${data.summary}

## 变更范围
${data.changedFiles.map(f => `- ${f}`).join('\n')}

## 测试情况
- 单元测试: ${data.testStatus.unitTests}
- 集成测试: ${data.testStatus.integrationTests}
${data.testStatus.coverage ? `- 测试覆盖: ${data.testStatus.coverage}` : ''}

## 已知问题
${data.knownIssues.length > 0 ? data.knownIssues.map(i => `- ${i}`).join('\n') : '(无)'}

## 下次继续（如需打回）
${'(由 Review 填写)'}

---
Generated: ${timestamp}
`;
}

/**
 * Parse existing HANDOVER.md to extract data
 */
export function parseHandover(content: string): ParsedHandover | null {
  try {
    const lines = content.split('\n');
    let section = '';
    const result: ParsedHandover = {
      summary: '',
      changedFiles: [],
      testStatus: { unitTests: 'N/A', integrationTests: 'N/A' },
      knownIssues: []
    };

    for (const line of lines) {
      if (line.startsWith('## ')) {
        section = line.replace('## ', '').trim();
      } else if (section === '开发摘要' && line.trim()) {
        result.summary = line.replace(/^- /, '').trim();
      } else if (section === '变更范围' && line.trim().startsWith('- ')) {
        result.changedFiles.push(line.replace(/^- /, '').trim());
      } else if (section === '测试情况') {
        if (line.includes('单元测试:')) {
          result.testStatus.unitTests = line.split(':')[1].trim();
        } else if (line.includes('集成测试:')) {
          result.testStatus.integrationTests = line.split(':')[1].trim();
        } else if (line.includes('测试覆盖:')) {
          result.testStatus.coverage = line.split(':')[1].trim();
        }
      } else if (section === '已知问题' && line.trim().startsWith('- ')) {
        result.knownIssues.push(line.replace(/^- /, '').trim());
      }
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Update "下次继续（如需打回）" section in existing HANDOVER.md
 */
export function updateHandoverNextSteps(content: string, nextSteps: string): string {
  const lines = content.split('\n');
  let inNextSection = false;
  const updatedLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## 下次继续（如需打回）')) {
      inNextSection = true;
      updatedLines.push(line);
    } else if (inNextSection && line.startsWith('## ')) {
      inNextSection = false;
      updatedLines.push(line);
    } else if (inNextSection && !line.trim()) {
      // Skip empty lines in this section
      continue;
    } else if (inNextSection) {
      // Replace content in this section
      if (!updatedLines.includes(nextSteps)) {
        updatedLines.push(nextSteps);
      }
    } else {
      updatedLines.push(line);
    }
  }

  return updatedLines.join('\n');
}
