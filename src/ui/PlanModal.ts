import { Modal, Notice } from 'obsidian';
import { affectedFiles, guardPlan, planRisk, previewPlan } from '../agent/plan';
import type { App } from 'obsidian';
import type { PlanExecutor } from '../agent/PlanExecutor';
import type { VaultOperation, VaultPlan } from '../agent/plan';

const RISK_LABEL: Record<string, string> = {
  low:      'Low risk',
  moderate: 'Review before applying',
  high:     'Destructive — read carefully',
};

/**
 * The change preview (§24) and the confirmation gate (§25).
 *
 * Nothing in a plan reaches the vault except through this modal, and a
 * high-risk plan needs two deliberate clicks. The preview is built from the
 * operations that will actually run, after protected paths have been removed,
 * so what is shown and what happens cannot drift apart.
 */
export class PlanModal extends Modal {
  private plan: VaultPlan;
  private executor: PlanExecutor;
  private protectedPaths: string[];
  private onApply: (runnable: VaultPlan) => void;

  constructor(
    app: App,
    plan: VaultPlan,
    executor: PlanExecutor,
    protectedPaths: string[],
    onApply: (runnable: VaultPlan) => void,
  ) {
    super(app);
    this.plan = plan;
    this.executor = executor;
    this.protectedPaths = protectedPaths;
    this.onApply = onApply;
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle('Vault changes');

    const guarded = guardPlan(this.plan, this.protectedPaths);
    const runnable: VaultPlan = { ...this.plan, operations: guarded.allowed };
    const risk = planRisk(runnable);

    contentEl.createDiv({ cls: `cs-plan-risk cs-plan-risk--${risk}`, text: RISK_LABEL[risk] });

    if (this.plan.description) {
      contentEl.createDiv({ cls: 'cs-plan-desc', text: this.plan.description });
    }

    if (guarded.blocked.length > 0) {
      const warn = contentEl.createDiv('cs-plan-blocked');
      warn.createDiv({
        cls: 'cs-plan-blocked-head',
        text: `${guarded.blocked.length} operation(s) refused: protected paths`,
      });
      for (const b of guarded.blocked) {
        warn.createDiv({ cls: 'cs-plan-blocked-row', text: `${b.path} — matches "${b.pattern}"` });
      }
    }

    if (runnable.operations.length === 0) {
      contentEl.createDiv({ cls: 'cs-plan-empty', text: 'Nothing left to apply.' });
      this.buttons(contentEl, runnable, risk, false);
      return;
    }

    contentEl.createEl('pre', { cls: 'cs-plan-preview' })
      .createEl('code', { text: previewPlan(runnable) });

    const files = affectedFiles(runnable);
    const summary = contentEl.createDiv({
      cls: 'cs-plan-summary',
      text: `${runnable.operations.length} operation(s), ${files.length} file(s)`,
    });

    // Link consequences are predicted before the user decides, not reported
    // afterwards, because they are part of what is being approved.
    void this.executor.predictLinkUpdates(runnable).then(updates => {
      if (updates.length === 0) return;
      const total = updates.reduce((n, u) => n + u.changed, 0);
      summary.setText(
        `${runnable.operations.length} operation(s), ${files.length} file(s) · `
        + `${total} link(s) in ${updates.length} other note(s) will be updated by Obsidian`);
    });

    this.buttons(contentEl, runnable, risk, true);
  }

  private buttons(parent: HTMLElement, runnable: VaultPlan, risk: string, canApply: boolean): void {
    const row = parent.createDiv('cs-plan-buttons');

    if (canApply) {
      const apply = row.createEl('button', { cls: 'mod-cta', text: 'Apply changes' });
      let armed = risk !== 'high';
      apply.addEventListener('click', () => {
        // A destructive plan takes two deliberate clicks, and the button says
        // what the second one will do.
        if (!armed) {
          armed = true;
          apply.addClass('cs-plan-armed');
          apply.setText(`Confirm — apply ${runnable.operations.length} operation(s)`);
          return;
        }
        this.close();
        this.onApply(runnable);
      });
    }

    row.createEl('button', { text: 'Cancel' }).addEventListener('click', () => {
      new Notice('No changes were made.');
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export type { VaultOperation };
