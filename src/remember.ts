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
const rememberSources: RememberSource[] = ["recent", "notebook"];
const sourceMeta: Record<RememberSource, (count: number) => string> = {
  recent: (count) => `临时想到的 ${count} 条`,
  notebook: (count) => `牢牢记下的 ${count} 条`,
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
  private readonly scrollPositions: Record<RememberSource, number> = {
    recent: 0,
    notebook: 0,
  };

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
    this.captureScrollPositions();
    this.root.replaceChildren();
    const shellClass = this.snapshot?.error ? "remember-shell with-error" : "remember-shell";
    const shell = element("section", shellClass);
    const header = element("header", "remember-header");
    const titleBlock = element("div", "remember-title-block");
    const titleCopy = element("div");
    titleCopy.append(
      element("h1", "", "记忆力"),
      element(
        "p",
        "remember-summary",
        this.snapshot
          ? `记忆中 ${this.snapshot.recent.length}/${this.snapshot.recentLimit} · 笔记本 ${this.snapshot.notebook.length}/${this.snapshot.notebookLimit}`
          : "正在翻看记忆",
      ),
    );
    titleBlock.append(element("span", "remember-title-icon"), titleCopy);
    header.append(titleBlock);

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

    shell.append(header);
    if (this.snapshot?.error) {
      shell.append(this.renderError(this.snapshot.error));
    }
    shell.append(layout);
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
    const emptyClass = items.length === 0 ? " empty" : "";
    const section = element("section", `remember-section ${source}${emptyClass}`);
    const header = element("div", "remember-section-header");
    const title = element("div", "remember-section-title");
    title.append(
      element("h2", "", sourceLabels[source]),
      element("p", "", sourceMeta[source](items.length)),
    );
    header.append(title);
    section.append(header);

    if (items.length === 0) {
      const emptyText =
        source === "recent"
          ? "复制文本后会被 Deskmon 临时想到这里，退出后清空。"
          : "点击“记住它”后会加密保存在本机。";
      section.append(element("p", "remember-empty", emptyText));
      return section;
    }

    const list = element("div", "remember-list");
    list.dataset.source = source;
    list.addEventListener("scroll", () => {
      this.scrollPositions[source] = list.scrollTop;
    });
    for (const item of items) {
      list.append(this.renderRow(source, item));
    }
    section.append(list);
    this.restoreScrollPosition(source, list);
    return section;
  }

  private renderRow(source: RememberSource, item: RememberItem): HTMLElement {
    const rowSelection: Selection = { source, id: item.id };
    const selected = this.selection?.source === source && this.selection.id === item.id;
    const row = element("article", selected ? "remember-row selected" : "remember-row");
    const mainButton = element("button", "remember-row-main");
    mainButton.addEventListener("click", () => this.selectItem(rowSelection));
    mainButton.append(element("span", "remember-row-preview", item.preview));
    if (item.pinned) {
      mainButton.append(element("span", "remember-row-chip", "置顶"));
    }

    const actions = element("div", "remember-row-actions");
    actions.append(this.rowActionButton("回忆", rowSelection, () => this.resetClipboard(rowSelection)));
    if (source === "recent") {
      actions.append(
        this.rowActionButton("记住它", rowSelection, () => this.saveItem(rowSelection)),
        this.rowActionButton("忘记", rowSelection, () => this.forgetRecent(rowSelection), "danger"),
      );
    } else {
      actions.append(
        this.rowActionButton(item.pinned ? "取消置顶" : "置顶", rowSelection, () =>
          this.setPinned(rowSelection, !item.pinned),
        ),
        this.rowActionButton("忘记", rowSelection, () => this.forgetNotebook(rowSelection), "danger"),
      );
    }

    row.append(mainButton, actions);
    return row;
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
    if (selection.source === "recent") {
      badges.append(element("span", "remember-badge", "临时"));
    }
    if (item.pinned) {
      badges.append(element("span", "remember-badge", "置顶"));
    }
    if (item.truncated) {
      badges.append(element("span", "remember-badge warning", "已截断"));
    }
    header.append(title, badges);

    const text = document.createElement("textarea");
    text.className = "remember-text";
    text.readOnly = true;
    text.value = item.text;

    const status = element("p", `remember-status ${this.statusTone}`, this.status);
    pane.append(header, text, status);
    return pane;
  }

  private rowActionButton(
    label: string,
    selection: Selection,
    action: () => Promise<void>,
    tone: "normal" | "danger" = "normal",
  ): HTMLButtonElement {
    const button = element("button", `remember-row-action ${tone}`, label);
    button.disabled = this.busy;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.selection = selection;
      void action();
    });
    return button;
  }

  private selectItem(selection: Selection): void {
    this.selection = selection;
    this.render();
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

  private captureScrollPositions(): void {
    for (const source of rememberSources) {
      const list = this.root.querySelector<HTMLElement>(
        `.remember-list[data-source="${source}"]`,
      );
      if (list) {
        this.scrollPositions[source] = list.scrollTop;
      }
    }
  }

  private restoreScrollPosition(source: RememberSource, list: HTMLElement): void {
    const scrollTop = this.scrollPositions[source];
    requestAnimationFrame(() => {
      const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
      list.scrollTop = Math.min(scrollTop, maxScrollTop);
    });
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
