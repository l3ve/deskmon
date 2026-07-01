import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RememberItem, RememberSnapshot, RememberSource } from "./types";

interface Selection {
  source: RememberSource;
  id: string;
}

const sourceLabels: Record<RememberSource, string> = {
  recent: "记忆中",
  notebook: "笔记本",
};

export function mountRemember(root: HTMLElement): void {
  const app = new RememberController(root);
  void app.start();
}

class RememberController {
  private snapshot: RememberSnapshot | null = null;
  private selection: Selection | null = null;
  private busy = false;
  private status = "";
  private statusTone: "neutral" | "success" | "warning" | "error" = "neutral";

  constructor(private readonly root: HTMLElement) {}

  async start(): Promise<void> {
    this.root.className = "remember-root";
    await this.refresh();
    void listen<RememberSnapshot>("deskmon-remember-changed", (event) => {
      this.applySnapshot(event.payload);
    });
  }

  private async refresh(): Promise<void> {
    try {
      this.applySnapshot(await invoke<RememberSnapshot>("get_remember_snapshot"));
    } catch (error) {
      this.setStatus(String(error), "error");
    }
  }

  private applySnapshot(snapshot: RememberSnapshot): void {
    this.snapshot = snapshot;
    this.ensureSelection();
    this.render();
  }

  private ensureSelection(): void {
    if (!this.snapshot) {
      this.selection = null;
      return;
    }
    if (this.selection && this.findItem(this.selection)) {
      return;
    }
    const firstRecent = this.snapshot.recent[0];
    if (firstRecent) {
      this.selection = { source: "recent", id: firstRecent.id };
      return;
    }
    const firstNotebook = this.snapshot.notebook[0];
    this.selection = firstNotebook ? { source: "notebook", id: firstNotebook.id } : null;
  }

  private render(): void {
    this.root.replaceChildren();
    const shell = element("section", "remember-shell");
    const header = element("header", "remember-header");
    const titleBlock = element("div");
    titleBlock.append(
      element("h1", "", "记忆力"),
      element(
        "p",
        "remember-summary",
        this.snapshot
          ? `记忆中 ${this.snapshot.recent.length}/${this.snapshot.recentLimit} · 笔记本 ${this.snapshot.notebook.length}/${this.snapshot.notebookLimit}`
          : "正在翻看记忆",
      ),
    );
    const refreshButton = element("button", "remember-icon-button", "刷新");
    refreshButton.disabled = this.busy;
    refreshButton.addEventListener("click", () => void this.refresh());
    header.append(titleBlock, refreshButton);

    const layout = element("main", "remember-layout");
    const listPane = element("section", "remember-list-pane");
    if (this.snapshot) {
      listPane.append(
        this.renderSection("recent", this.snapshot.recent),
        this.renderSection("notebook", this.snapshot.notebook),
      );
    }
    const detailPane = this.renderDetail();
    layout.append(listPane, detailPane);

    const status = element("p", `remember-status ${this.statusTone}`, this.status);
    shell.append(header);
    if (this.snapshot?.error) {
      shell.append(this.renderError(this.snapshot.error));
    }
    shell.append(layout, status);
    this.root.append(shell);
  }

  private renderError(message: string): HTMLElement {
    const banner = element("section", "remember-error");
    const text = element("p", "", message);
    const button = element("button", "danger-button", "重置记忆力");
    button.disabled = this.busy;
    button.addEventListener("click", () =>
      void this.mutate("remember_reset_notebook", {}, "已经重置记忆力"),
    );
    banner.append(text, button);
    return banner;
  }

  private renderSection(source: RememberSource, items: RememberItem[]): HTMLElement {
    const section = element("section", "remember-section");
    const header = element("div", "remember-section-header");
    header.append(element("h2", "", sourceLabels[source]));
    if (source === "recent" && items.length > 0) {
      const clearButton = element("button", "subtle-button", "全部忘记");
      clearButton.disabled = this.busy;
      clearButton.addEventListener("click", () =>
        void this.mutate("remember_clear_recent", {}, "记忆中已经清空"),
      );
      header.append(clearButton);
    }
    section.append(header);

    if (items.length === 0) {
      const emptyText =
        source === "recent"
          ? "复制文本后会被 Deskmon 临时捧来这里，退出后清空。"
          : "点击“记住它”后会加密保存在本机。";
      section.append(element("p", "remember-empty", emptyText));
      return section;
    }

    const list = element("div", "remember-list");
    for (const item of items) {
      const selected = this.selection?.source === source && this.selection.id === item.id;
      const button = element("button", selected ? "remember-row selected" : "remember-row");
      button.addEventListener("click", () => {
        this.selection = { source, id: item.id };
        this.render();
      });
      const preview = element("span", "remember-row-preview", item.preview);
      button.append(preview);
      if (item.pinned) {
        button.append(element("span", "remember-row-chip", "置顶"));
      }
      list.append(button);
    }
    section.append(list);
    return section;
  }

  private renderDetail(): HTMLElement {
    const pane = element("section", "remember-detail-pane");
    const selection = this.selection;
    const item = selection ? this.findItem(selection) : null;
    if (!selection || !item) {
      pane.append(
        element("h2", "", "还没有可翻的记忆"),
        element("p", "remember-empty", "复制一段文本后，它会先出现在记忆中。"),
      );
      return pane;
    }

    const header = element("div", "remember-detail-header");
    const title = element("div");
    title.append(element("h2", "", sourceLabels[selection.source]));
    const badges = element("div", "remember-badges");
    if (item.pinned) {
      badges.append(element("span", "remember-badge", "放在最上面"));
    }
    if (item.truncated) {
      badges.append(element("span", "remember-badge warning", "已截断"));
    }
    header.append(title, badges);

    const text = document.createElement("textarea");
    text.className = "remember-text";
    text.readOnly = true;
    text.value = item.text;

    const actions = element("div", "remember-actions");
    actions.append(this.actionButton("回忆", () => this.resetClipboard(selection)));
    if (selection.source === "recent") {
      actions.append(
        this.actionButton("记住它", () => this.saveItem(selection)),
        this.actionButton("忘记", () => this.forgetRecent(selection), "danger"),
      );
    } else {
      actions.append(
        this.actionButton(item.pinned ? "取消放在最上面" : "放在最上面", () =>
          this.setPinned(selection, !item.pinned),
        ),
        this.actionButton("忘记", () => this.forgetNotebook(selection), "danger"),
      );
    }

    pane.append(header, text, actions);
    return pane;
  }

  private actionButton(
    label: string,
    action: () => Promise<void>,
    tone: "normal" | "danger" = "normal",
  ): HTMLButtonElement {
    const button = element("button", tone === "danger" ? "danger-button" : "primary-button", label);
    button.disabled = this.busy;
    button.addEventListener("click", () => void action());
    return button;
  }

  private async resetClipboard(selection: Selection): Promise<void> {
    await this.mutate(
      "remember_reset_clipboard",
      { source: selection.source, id: selection.id },
      "已经放回剪贴板",
    );
  }

  private async saveItem(selection: Selection): Promise<void> {
    await this.mutate(
      "remember_save_item",
      { source: selection.source, id: selection.id },
      "已经记住它",
    );
  }

  private async forgetRecent(selection: Selection): Promise<void> {
    await this.mutate("remember_forget_recent", { id: selection.id }, "已经忘记");
  }

  private async forgetNotebook(selection: Selection): Promise<void> {
    await this.mutate("remember_forget_notebook", { id: selection.id }, "已经忘记");
  }

  private async setPinned(selection: Selection, pinned: boolean): Promise<void> {
    await this.mutate(
      "remember_set_notebook_pinned",
      { id: selection.id, pinned },
      pinned ? "已经放在最上面" : "已经取消放在最上面",
    );
  }

  private async mutate(
    command: string,
    args: Record<string, unknown>,
    success: string,
  ): Promise<void> {
    this.busy = true;
    this.setStatus("Deskmon 正在翻笔记", "neutral");
    try {
      const snapshot = await invoke<RememberSnapshot>(command, args);
      this.busy = false;
      this.status = success;
      this.statusTone = "success";
      this.applySnapshot(snapshot);
    } catch (error) {
      this.busy = false;
      this.setStatus(String(error), "error");
    }
  }

  private setStatus(
    message: string,
    tone: "neutral" | "success" | "warning" | "error" = "neutral",
  ): void {
    this.status = message;
    this.statusTone = tone;
    this.render();
  }

  private findItem(selection: Selection): RememberItem | null {
    if (!this.snapshot) {
      return null;
    }
    const items = selection.source === "recent" ? this.snapshot.recent : this.snapshot.notebook;
    return items.find((item) => item.id === selection.id) ?? null;
  }

}

function element<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className = "",
  textContent = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  if (className) {
    node.className = className;
  }
  if (textContent) {
    node.textContent = textContent;
  }
  return node;
}
