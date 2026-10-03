import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, applyBankConfig } from '../src/upstream/config.js';
import { deriveBankIdOrSkip } from '../src/upstream/bank.js';
it('preserves official file/harness/bank layering and root/subdirectory/worktree routing', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-hindsight-routing-')));
  try {
    const repo = join(root, 'owner', 'project'),
      wt = join(root, 'worktree'),
      other = join(root, 'other', 'project');
    for (const p of [join(repo, '.git/worktrees/wt'), join(repo, 'src'), wt, join(other, '.git')])
      mkdirSync(p, { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git/worktrees/wt')}\n`);
    writeFileSync(join(repo, '.git/worktrees/wt/commondir'), '../..\n');
    const path = join(root, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        bankId: 'fallback',
        mapPathToBank: { [repo]: 'shared-bank' },
        reflectBudget: 'low',
        harnesses: { pi: { reflectBudget: 'mid' } },
        banks: {
          'shared-bank': {
            reflectBudget: 'high',
            retainSessions: false,
            bankId: 'must-not-reroute',
          },
        },
      }),
    );
    const cfg = loadConfig({ path, harness: 'pi' });
    expect(cfg.reflectBudget).toBe('mid');
    for (const cwd of [repo, join(repo, 'src'), wt]) {
      expect(deriveBankIdOrSkip(cfg, cwd, 'pi', repo)).toBe('shared-bank');
      const resolved = applyBankConfig(cfg, 'shared-bank', cwd);
      expect(resolved.bankId).toBe('shared-bank');
      expect(resolved.cfg.reflectBudget).toBe('high');
      expect(resolved.cfg.retainSessions).toBe(false);
    }
    expect(deriveBankIdOrSkip(cfg, other, 'pi', other)).toBe('fallback');
    expect(deriveBankIdOrSkip({ ...cfg, bankId: undefined }, other, 'pi', other)).toBe(
      'coding-agent::project',
    );
    expect(applyBankConfig({ ...cfg, optInOnly: true }, 'fallback', other).cfg.disabled).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
