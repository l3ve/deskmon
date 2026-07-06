import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  RememberItem,
  RememberSnapshot,
  RememberSource,
  RememberVariableItem,
} from "./types";

interface Selection {
  source: ListSource;
  id: string;
}

type ListSource = RememberSource | "variable";
type RememberFilter = "all" | ListSource;
type StatusTone = "neutral" | "success" | "warning" | "error";
type DetailMode = "detail" | "create" | "edit";
type VariableField = "key" | "value";

interface VariableFormDraft {
  id?: string;
  key: string;
  value: string;
  note: string;
  errors: Partial<Record<VariableField, string>>;
}

interface SectionModel {
  source: ListSource;
  title: string;
  meta: string;
  emptyText: string;
  items: RowModel[];
}

interface RowModel {
  source: ListSource;
  id: string;
  title: string;
  subtitle: string;
  badges: string[];
  item?: RememberItem;
  variable?: RememberVariableItem;
}

const sourceLabels: Record<ListSource, string> = {
  recent: "记忆中",
  notebook: "笔记本",
  variable: "变量",
};

const filterLabels: Record<RememberFilter, string> = {
  all: "全部",
  recent: "记忆中",
  notebook: "笔记本",
  variable: "变量",
};

const listSources: ListSource[] = ["recent", "notebook", "variable"];
const filterOrder: RememberFilter[] = ["all", ...listSources];
const fallbackVariableLimit = 50;

const sourceMeta: Record<ListSource, (count: number, limit?: number) => string> = {
  recent: (count, limit) => `临时想到的 ${count}/${limit ?? 10}`,
  notebook: (count, limit) => `牢牢记下的 ${count}/${limit ?? 50}`,
  variable: (count, limit) => `私密 key ${count}/${limit ?? fallbackVariableLimit}`,
};

export function mountRemember(root: HTMLElement): void {
  const app = new RememberController(root);
  void app.start();
}

class RememberController {
  private snapshot: RememberSnapshot | null = null;
  private selection: Selection | null = null;
  private filter: RememberFilter = "all";
  private query = "";
  private busy = false;
  private status = "";
  private statusTone: StatusTone = "neutral";
  private detailMode: DetailMode = "detail";
  private variableDraft: VariableFormDraft | null = null;
  private revealedVariableId: string | null = null;
  private revealedVariableValue = "";
  private focusSearchAfterRender = false;
  private searchSelectionStart = 0;
  private readonly scrollPositions: Record<ListSource, number> = {
    recent: 0,
    notebook: 0,
    variable: 0,
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
    this.clearRevealedVariable();
    if (
      this.detailMode === "edit" &&
      this.variableDraft?.id &&
      !snapshot.variables.some((variable) => variable.id === this.variableDraft?.id)
    ) {
      this.detailMode = "detail";
      this.variableDraft = null;
    }
    this.ensureSelection();
    this.render();
  }

  private ensureSelection(): void {
    const previous = this.selection ? `${this.selection.source}:${this.selection.id}` : "";
    if (!this.snapshot) {
      this.selection = null;
      return;
    }
    if (this.selection && this.selectionVisible(this.selection)) {
      return;
    }
    this.selection = this.firstVisibleSelection();
    const current = this.selection ? `${this.selection.source}:${this.selection.id}` : "";
    if (previous !== current) {
      this.clearRevealedVariable();
    }
  }

  private render(): void {
    this.captureScrollPositions();
    this.ensureSelection();
    this.root.replaceChildren();
    const shellClass = this.snapshot?.error ? "remember-shell with-error" : "remember-shell";
    const shell = element("section", shellClass);
    shell.append(this.renderHeader(), this.renderToolbar());
    if (this.snapshot?.error) {
      shell.append(this.renderError(this.snapshot.error));
    }

    const layout = element("main", "remember-layout");
    layout.append(this.renderListPane(), this.renderDetail());
    shell.append(layout);
    this.root.append(shell);
    this.restoreSearchFocus();
  }

  private renderHeader(): HTMLElement {
    const header = element("header", "remember-header");
    const titleBlock = element("div", "remember-title-block");
    const titleCopy = element("div");
    const summary = this.snapshot
      ? [
          `记忆中 ${this.snapshot.recent.length}/${this.snapshot.recentLimit}`,
          `笔记本 ${this.snapshot.notebook.length}/${this.snapshot.notebookLimit}`,
          `变量 ${this.variables.length}/${this.variableLimit}`,
        ].join(" · ")
      : "正在翻看记忆";
    titleCopy.append(
      element("h1", "", "记忆力"),
      element("p", "remember-summary", summary),
    );
    titleBlock.append(element("span", "remember-title-icon"), titleCopy);
    header.append(titleBlock);
    return header;
  }

  private renderToolbar(): HTMLElement {
    const toolbar = element("nav", "remember-toolbar");
    const filters = element("div", "remember-filter");
    filters.setAttribute("aria-label", "记忆来源");
    for (const filter of filterOrder) {
      const button = element(
        "button",
        filter === this.filter ? "remember-filter-button selected" : "remember-filter-button",
        filterLabels[filter],
      );
      button.type = "button";
      button.setAttribute("aria-pressed", String(filter === this.filter));
      button.addEventListener("click", () => {
        this.filter = filter;
        this.detailMode = "detail";
        this.variableDraft = null;
        this.clearRevealedVariable();
        this.ensureSelection();
        this.render();
      });
      filters.append(button);
    }

    const searchWrap = element("label", "remember-search");
    searchWrap.append(element("span", "remember-search-icon"));
    const search = document.createElement("input");
    search.className = "remember-search-input";
    search.type = "search";
    search.placeholder = "搜索记忆、笔记本或变量 key";
    search.value = this.query;
    search.addEventListener("input", () => {
      this.query = search.value;
      this.searchSelectionStart = search.selectionStart ?? search.value.length;
      this.focusSearchAfterRender = true;
      this.ensureSelection();
      this.render();
    });
    search.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.query) {
        event.preventDefault();
        this.query = "";
        this.searchSelectionStart = 0;
        this.focusSearchAfterRender = true;
        this.ensureSelection();
        this.render();
      }
    });
    searchWrap.append(search);

    const addVariable = element("button", "primary-button remember-add-variable", "新增变量");
    addVariable.type = "button";
    addVariable.disabled = this.busy || this.variables.length >= this.variableLimit;
    if (this.variables.length >= this.variableLimit) {
      addVariable.title = "变量已经满了";
    }
    addVariable.addEventListener("click", () => {
      this.openCreateVariableForm();
    });

    toolbar.append(filters, searchWrap, addVariable);
    return toolbar;
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

  private renderListPane(): HTMLElement {
    const listPane = element("section", "remember-list-pane");
    for (const section of this.visibleSections()) {
      listPane.append(this.renderSection(section));
    }
    return listPane;
  }

  private renderSection(model: SectionModel): HTMLElement {
    const emptyClass = model.items.length === 0 ? " empty" : "";
    const section = element("section", `remember-section ${model.source}${emptyClass}`);
    const header = element("div", "remember-section-header");
    const title = element("div", "remember-section-title");
    title.append(element("h2", "", model.title), element("p", "", model.meta));
    header.append(title);
    if (model.source === "variable") {
      header.append(this.renderVariableCleanupToggle());
    }
    section.append(header);

    if (model.items.length === 0) {
      section.append(element("p", "remember-empty", model.emptyText));
      return section;
    }

    const list = element("div", "remember-list");
    list.dataset.source = model.source;
    list.addEventListener("scroll", () => {
      this.scrollPositions[model.source] = list.scrollTop;
    });
    for (const row of model.items) {
      list.append(this.renderRow(row));
    }
    section.append(list);
    this.restoreScrollPosition(model.source, list);
    return section;
  }

  private renderRow(model: RowModel): HTMLElement {
    const rowSelection: Selection = { source: model.source, id: model.id };
    const selected =
      this.selection?.source === model.source && this.selection.id === model.id;
    const row = element(
      "article",
      selected ? `remember-row ${model.source} selected` : `remember-row ${model.source}`,
    );
    const mainButton = element("button", "remember-row-main");
    mainButton.addEventListener("click", () => this.selectItem(rowSelection));

    const copy = element("span", "remember-row-copy");
    copy.append(
      element("span", "remember-row-preview", model.title),
      element("span", "remember-row-meta", model.subtitle),
    );
    const chips = element("span", "remember-row-chips");
    for (const badge of model.badges) {
      chips.append(element("span", "remember-row-chip", badge));
    }
    mainButton.append(element("span", `remember-row-source ${model.source}`), copy, chips);

    const actions = element("div", "remember-row-actions");
    if (model.source === "variable") {
      actions.append(
        this.rowActionButton("复制 value", rowSelection, () => this.copyVariable(rowSelection)),
        this.rowActionButton("编辑", rowSelection, () => this.editVariable(rowSelection)),
        this.rowActionButton("删除", rowSelection, () => this.deleteVariable(rowSelection), "danger"),
      );
    } else {
      actions.append(
        this.rowActionButton("回忆", rowSelection, () => this.resetClipboard(rowSelection)),
      );
    }
    if (model.source === "recent") {
      actions.append(
        this.rowActionButton("记住它", rowSelection, () => this.saveItem(rowSelection)),
        this.rowActionButton("忘记", rowSelection, () => this.forgetRecent(rowSelection), "danger"),
      );
    } else if (model.source === "notebook" && model.item) {
      actions.append(
        this.rowActionButton(model.item.pinned ? "取消置顶" : "置顶", rowSelection, () =>
          this.setPinned(rowSelection, !model.item?.pinned),
        ),
        this.rowActionButton("忘记", rowSelection, () => this.forgetNotebook(rowSelection), "danger"),
      );
    }

    row.append(mainButton, actions);
    return row;
  }

  private renderDetail(): HTMLElement {
    const pane = element("section", "remember-detail-pane");
    if (this.detailMode === "create" && this.variableDraft) {
      pane.append(this.renderVariableForm("create"), this.renderStatus());
      return pane;
    }
    if (this.detailMode === "edit" && this.variableDraft) {
      pane.append(this.renderVariableForm("edit"), this.renderStatus());
      return pane;
    }

    const selection = this.selection;
    const item = selection ? this.findItem(selection) : null;
    if (!selection || !item) {
      const content = element("div", "remember-detail-content empty");
      content.append(element("div", "remember-detail-header"), this.renderDetailEmpty());
      pane.append(content, this.renderStatus());
      return pane;
    }

    if (selection.source === "variable") {
      pane.append(this.renderVariableDetail(item as RememberVariableItem), this.renderStatus());
      return pane;
    }

    pane.append(this.renderTextDetail(selection, item as RememberItem), this.renderStatus());
    return pane;
  }

  private renderDetailEmpty(): HTMLElement {
    const empty = element("div", "remember-detail-empty");
    const title = this.query.trim() ? "没有匹配结果" : "还没有可翻的记忆";
    const body = this.query.trim()
      ? "换个关键词，或者切回全部来源。"
      : "复制一段文本后，它会先出现在记忆中。";
    empty.append(element("h2", "", title), element("p", "", body));
    return empty;
  }

  private renderTextDetail(selection: Selection, item: RememberItem): HTMLElement {
    const wrapper = element("div", "remember-detail-content");

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

    const meta = element("div", "remember-detail-meta");
    meta.append(
      this.detailMetric("来源", sourceLabels[selection.source]),
      this.detailMetric("字符", `${item.text.length}`),
      this.detailMetric("上限", `${this.snapshot?.textLimit ?? 5000}`),
    );

    const text = document.createElement("textarea");
    text.className = "remember-text";
    text.readOnly = true;
    text.value = item.text;

    wrapper.append(header, meta, text);
    return wrapper;
  }

  private renderVariableDetail(variable: RememberVariableItem): HTMLElement {
    const wrapper = element("div", "remember-detail-content variable");
    const header = element("div", "remember-detail-header");
    const title = element("div");
    title.append(element("h2", "", variable.key));
    const badges = element("div", "remember-badges");
    badges.append(element("span", "remember-badge private", "私密"));
    header.append(title, badges);

    const valuePanel = element("section", "remember-secret-panel");
    const isRevealed = this.revealedVariableId === variable.id;
    const value = isRevealed ? this.revealedVariableValue : "••••••••••••••••";
    const valueNode = isRevealed
      ? document.createElement("textarea")
      : element("div", "remember-secret-value", value);
    valueNode.className = isRevealed
      ? "remember-secret-value revealed"
      : "remember-secret-value";
    if (valueNode instanceof HTMLTextAreaElement) {
      valueNode.readOnly = true;
      valueNode.value = value;
    }

    const secretActions = element("div", "remember-secret-actions");
    const revealButton = element(
      "button",
      "subtle-button",
      isRevealed ? "隐藏 value" : "显示 value",
    );
    revealButton.type = "button";
    revealButton.disabled = this.busy;
    revealButton.addEventListener("click", () => {
      if (isRevealed) {
        this.clearRevealedVariable();
        this.render();
        return;
      }
      void this.revealVariableValue({ source: "variable", id: variable.id });
    });
    const copyButton = element("button", "primary-button", "复制 value");
    copyButton.type = "button";
    copyButton.disabled = this.busy;
    copyButton.addEventListener("click", () =>
      void this.copyVariable({ source: "variable", id: variable.id }),
    );
    secretActions.append(revealButton, copyButton);
    valuePanel.append(
      element("p", "remember-detail-label", "VALUE"),
      valueNode,
      secretActions,
    );

    const notePanel = element("section", "remember-note-panel");
    notePanel.append(
      element("p", "remember-detail-label", "备注"),
      element("p", "remember-note-text", variable.note ?? "没有备注"),
    );

    const actions = element("div", "remember-detail-actions");
    const editButton = element("button", "subtle-button", "编辑");
    editButton.type = "button";
    editButton.disabled = this.busy;
    editButton.addEventListener("click", () =>
      void this.editVariable({ source: "variable", id: variable.id }),
    );
    const deleteButton = element("button", "danger-button", "删除");
    deleteButton.type = "button";
    deleteButton.disabled = this.busy;
    deleteButton.addEventListener("click", () =>
      void this.deleteVariable({ source: "variable", id: variable.id }),
    );
    actions.append(editButton, deleteButton);

    wrapper.append(header, valuePanel, notePanel, actions);
    return wrapper;
  }

  private renderVariableForm(mode: Exclude<DetailMode, "detail">): HTMLElement {
    const draft = this.variableDraft ?? this.emptyVariableDraft();
    this.variableDraft = draft;
    const wrapper = element("div", "remember-detail-content variable");
    const header = element("div", "remember-detail-header");
    const title = element("div");
    title.append(element("h2", "", mode === "create" ? "新增变量" : "编辑变量"));
    const badges = element("div", "remember-badges");
    badges.append(element("span", "remember-badge private", "私密"));
    header.append(title, badges);

    const form = element("form", "remember-variable-form");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submitVariableForm(mode);
    });

    form.append(
      this.renderVariableField("key", "Key", draft.key, "变量名", false),
      this.renderVariableField("value", "Value", draft.value, "复制时写入剪贴板", true),
      this.renderVariableNoteField(draft.note),
    );

    const actions = element("div", "remember-form-actions");
    const cancel = element("button", "subtle-button", "取消");
    cancel.type = "button";
    cancel.disabled = this.busy;
    cancel.addEventListener("click", () => {
      this.detailMode = "detail";
      this.variableDraft = null;
      this.clearRevealedVariable();
      this.render();
    });
    const save = element("button", "primary-button", mode === "create" ? "保存变量" : "保存修改");
    save.type = "submit";
    save.disabled = this.busy;
    actions.append(cancel, save);
    form.append(actions);

    wrapper.append(header, form);
    return wrapper;
  }

  private renderVariableField(
    field: VariableField,
    label: string,
    value: string,
    placeholder: string,
    multiline: boolean,
  ): HTMLElement {
    const fieldWrap = element("label", "remember-form-field");
    fieldWrap.append(element("span", "remember-detail-label", label));
    const input = multiline ? document.createElement("textarea") : document.createElement("input");
    input.className = multiline ? "remember-form-textarea" : "remember-form-input";
    input.placeholder = placeholder;
    input.value = value;
    input.disabled = this.busy;
    if (!multiline && input instanceof HTMLInputElement) {
      input.type = "text";
    }
    input.addEventListener("input", () => {
      if (!this.variableDraft) {
        return;
      }
      this.variableDraft[field] = input.value;
      delete this.variableDraft.errors[field];
    });
    fieldWrap.append(input);
    const error = this.variableDraft?.errors[field];
    if (error) {
      fieldWrap.append(element("span", "remember-form-error", error));
    }
    return fieldWrap;
  }

  private renderVariableNoteField(value: string): HTMLElement {
    const fieldWrap = element("label", "remember-form-field");
    fieldWrap.append(element("span", "remember-detail-label", "备注"));
    const input = document.createElement("textarea");
    input.className = "remember-form-textarea compact";
    input.placeholder = "可选，只显示备注，不显示 value";
    input.value = value;
    input.disabled = this.busy;
    input.addEventListener("input", () => {
      if (this.variableDraft) {
        this.variableDraft.note = input.value;
      }
    });
    fieldWrap.append(input);
    return fieldWrap;
  }

  private renderVariableCleanupToggle(): HTMLElement {
    const row = element("label", "remember-cleanup-toggle toggle-row");
    row.title = "复制任意变量后，30 秒后若剪贴板仍是该 value 则清空";
    row.addEventListener("click", (event) => event.stopPropagation());
    const switchWrap = element("span", "switch");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", "变量复制自动清理");
    checkbox.checked = this.variableCleanupEnabled;
    checkbox.disabled = this.busy;
    checkbox.addEventListener("change", (event) => {
      event.stopPropagation();
      void this.setVariableCleanupEnabled(checkbox.checked);
    });
    switchWrap.append(checkbox, element("span", "switch-track"));
    row.append(element("span", "remember-cleanup-label", "自动清理"), switchWrap);
    return row;
  }

  private detailMetric(label: string, value: string): HTMLElement {
    const metric = element("div", "remember-detail-metric");
    metric.append(element("span", "", label), element("strong", "", value));
    return metric;
  }

  private renderStatus(): HTMLElement {
    return element("p", `remember-status ${this.statusTone}`, this.status);
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
    this.detailMode = "detail";
    this.variableDraft = null;
    this.clearRevealedVariable();
    if (selection.source === "variable") {
      this.filter = this.filter === "all" ? "all" : "variable";
    }
    this.render();
  }

  private async resetClipboard(selection: Selection): Promise<void> {
    if (selection.source === "variable") {
      await this.copyVariable(selection);
      return;
    }
    await this.mutate(
      "remember_reset_clipboard",
      { source: selection.source, id: selection.id },
      "已经放回剪贴板",
    );
  }

  private async saveItem(selection: Selection): Promise<void> {
    if (selection.source !== "recent") {
      return;
    }
    await this.mutate(
      "remember_save_item",
      { source: selection.source, id: selection.id },
      "已经记住它",
    );
  }

  private async forgetRecent(selection: Selection): Promise<void> {
    if (selection.source !== "recent") {
      return;
    }
    await this.mutate("remember_forget_recent", { id: selection.id }, "已经忘记");
  }

  private async forgetNotebook(selection: Selection): Promise<void> {
    if (selection.source !== "notebook") {
      return;
    }
    await this.mutate("remember_forget_notebook", { id: selection.id }, "已经忘记");
  }

  private async setPinned(selection: Selection, pinned: boolean): Promise<void> {
    if (selection.source !== "notebook") {
      return;
    }
    await this.mutate(
      "remember_set_notebook_pinned",
      { id: selection.id, pinned },
      pinned ? "已经放在最上面" : "已经取消放在最上面",
    );
  }

  private async copyVariable(selection: Selection): Promise<void> {
    if (selection.source !== "variable") {
      return;
    }
    const variable = this.findItem(selection) as RememberVariableItem | null;
    const success = variable
      ? `已复制变量 ${variable.key}${this.variableCleanupEnabled ? "，30 秒后会尝试清理剪贴板" : ""}`
      : "已复制变量";
    await this.mutate("remember_copy_variable", { id: selection.id }, success);
  }

  private async editVariable(selection: Selection): Promise<void> {
    if (selection.source !== "variable") {
      return;
    }
    const variable = this.findItem(selection) as RememberVariableItem | null;
    if (!variable) {
      this.setStatus("没有找到这个变量", "error");
      return;
    }

    this.busy = true;
    this.setStatus("Deskmon 正在取出 value", "neutral");
    try {
      const value = await invoke<string>("remember_reveal_variable_value", { id: selection.id });
      this.busy = false;
      this.selection = selection;
      this.detailMode = "edit";
      this.variableDraft = {
        id: selection.id,
        key: variable.key,
        value,
        note: variable.note ?? "",
        errors: {},
      };
      this.clearRevealedVariable();
      this.status = "";
      this.statusTone = "neutral";
      this.render();
    } catch (error) {
      this.busy = false;
      this.setStatus(String(error), "error");
    }
  }

  private async deleteVariable(selection: Selection): Promise<void> {
    if (selection.source !== "variable") {
      return;
    }

    this.busy = true;
    this.setStatus("Deskmon 正在确认变量", "neutral");
    try {
      const snapshot = await invoke<RememberSnapshot>("remember_delete_variable", {
        id: selection.id,
      });
      this.busy = false;
      const deleted = !snapshot.variables.some((variable) => variable.id === selection.id);
      this.status = deleted ? "已经删除变量" : "已保留变量";
      this.statusTone = deleted ? "success" : "neutral";
      this.detailMode = "detail";
      this.variableDraft = null;
      this.applySnapshot(snapshot);
    } catch (error) {
      this.busy = false;
      this.setStatus(String(error), "error");
    }
  }

  private async revealVariableValue(selection: Selection): Promise<void> {
    if (selection.source !== "variable") {
      return;
    }
    this.busy = true;
    this.setStatus("Deskmon 正在取出 value", "neutral");
    try {
      const value = await invoke<string>("remember_reveal_variable_value", { id: selection.id });
      this.busy = false;
      this.revealedVariableId = selection.id;
      this.revealedVariableValue = value;
      this.status = "";
      this.statusTone = "neutral";
      this.render();
    } catch (error) {
      this.busy = false;
      this.setStatus(String(error), "error");
    }
  }

  private async setVariableCleanupEnabled(enabled: boolean): Promise<void> {
    await this.mutate(
      "remember_set_variable_clipboard_cleanup_enabled",
      { enabled },
      enabled ? "已开启复制后自动清理" : "已关闭复制后自动清理",
    );
  }

  private openCreateVariableForm(): void {
    this.filter = "variable";
    this.selection = null;
    this.detailMode = "create";
    this.variableDraft = this.emptyVariableDraft();
    this.clearRevealedVariable();
    this.status = "";
    this.statusTone = "neutral";
    this.render();
  }

  private async submitVariableForm(mode: Exclude<DetailMode, "detail">): Promise<void> {
    const draft = this.variableDraft;
    if (!draft) {
      return;
    }
    if (!this.validateVariableDraft(draft)) {
      this.render();
      return;
    }

    const key = draft.key.trim();
    const value = draft.value.trim();
    const note = draft.note.trim() || null;
    const command =
      mode === "create" ? "remember_create_variable" : "remember_update_variable";
    const args =
      mode === "create"
        ? { key, value, note }
        : { id: draft.id, key, value, note };

    this.busy = true;
    this.setStatus("Deskmon 正在整理变量", "neutral");
    try {
      const snapshot = await invoke<RememberSnapshot>(command, args);
      const selected =
        snapshot.variables.find(
          (variable) => variable.key.toLocaleLowerCase() === key.toLocaleLowerCase(),
        ) ?? snapshot.variables[0];
      this.busy = false;
      this.detailMode = "detail";
      this.variableDraft = null;
      this.selection = selected ? { source: "variable", id: selected.id } : null;
      this.status = mode === "create" ? "已经保存变量" : "已经更新变量";
      this.statusTone = "success";
      this.applySnapshot(snapshot);
    } catch (error) {
      this.busy = false;
      this.setStatus(String(error), "error");
    }
  }

  private validateVariableDraft(draft: VariableFormDraft): boolean {
    const key = draft.key.trim();
    const value = draft.value.trim();
    const errors: VariableFormDraft["errors"] = {};
    if (!key) {
      errors.key = "key 不能为空";
    } else if (
      this.variables.some(
        (variable) =>
          variable.id !== draft.id &&
          variable.key.toLocaleLowerCase() === key.toLocaleLowerCase(),
      )
    ) {
      errors.key = "这个 key 已经存在了";
    }
    if (!value) {
      errors.value = "value 不能为空";
    }
    draft.errors = errors;
    return Object.keys(errors).length === 0;
  }

  private emptyVariableDraft(): VariableFormDraft {
    return {
      key: "",
      value: "",
      note: "",
      errors: {},
    };
  }

  private clearRevealedVariable(): void {
    this.revealedVariableId = null;
    this.revealedVariableValue = "";
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
    tone: StatusTone = "neutral",
  ): void {
    this.status = message;
    this.statusTone = tone;
    this.render();
  }

  private findItem(selection: Selection): RememberItem | RememberVariableItem | null {
    if (!this.snapshot) {
      return null;
    }
    if (selection.source === "variable") {
      return this.variables.find((item) => item.id === selection.id) ?? null;
    }
    const items = selection.source === "recent" ? this.snapshot.recent : this.snapshot.notebook;
    return items.find((item) => item.id === selection.id) ?? null;
  }

  private get variables(): RememberVariableItem[] {
    return this.snapshot?.variables ?? [];
  }

  private get variableLimit(): number {
    return this.snapshot?.variableLimit ?? fallbackVariableLimit;
  }

  private get variableCleanupEnabled(): boolean {
    return this.snapshot?.variableClipboardCleanupEnabled ?? false;
  }

  private visibleSections(): SectionModel[] {
    if (!this.snapshot) {
      return [];
    }
    const query = this.query.trim().toLocaleLowerCase();
    const allSections: SectionModel[] = [
      this.sectionFromItems(
        "recent",
        this.snapshot.recent,
        this.snapshot.recentLimit,
        query,
        "复制文本后会被 Deskmon 临时想到这里，退出后清空。",
      ),
      this.sectionFromItems(
        "notebook",
        this.snapshot.notebook,
        this.snapshot.notebookLimit,
        query,
        "点击“记住它”后会加密保存在本机。",
      ),
      this.variableSection(query),
    ];
    return allSections.filter((section) => this.filter === "all" || section.source === this.filter);
  }

  private sectionFromItems(
    source: RememberSource,
    items: RememberItem[],
    limit: number,
    query: string,
    emptyText: string,
  ): SectionModel {
    const filtered = query
      ? items.filter((item) => item.text.toLocaleLowerCase().includes(query))
      : items;
    return {
      source,
      title: sourceLabels[source],
      meta: sourceMeta[source](filtered.length, limit),
      emptyText: query ? "没有匹配的内容。" : emptyText,
      items: filtered.map((item) => this.rowFromItem(source, item)),
    };
  }

  private variableSection(query: string): SectionModel {
    const variables = query
      ? this.variables.filter((variable) =>
          [variable.key, variable.note ?? ""].some((value) =>
            value.toLocaleLowerCase().includes(query),
          ),
        )
      : this.variables;
    const emptyText = query
      ? "没有匹配的变量。"
      : "新增变量后，这里只显示 key 和备注。";
    return {
      source: "variable",
      title: sourceLabels.variable,
      meta: sourceMeta.variable(variables.length, this.variableLimit),
      emptyText,
      items: variables.map((variable) => this.rowFromVariable(variable)),
    };
  }

  private rowFromItem(source: RememberSource, item: RememberItem): RowModel {
    const badges: string[] = [];
    if (item.pinned) {
      badges.push("置顶");
    }
    if (item.truncated) {
      badges.push("截断");
    }
    const subtitle = [
      source === "recent" ? "临时" : "已保存",
      item.pinned ? "放在最上面" : "",
      item.truncated ? "已截断" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      source,
      id: item.id,
      title: item.preview,
      subtitle,
      badges,
      item,
    };
  }

  private rowFromVariable(variable: RememberVariableItem): RowModel {
    return {
      source: "variable",
      id: variable.id,
      title: variable.key,
      subtitle: variable.note || "私密 value 默认隐藏",
      badges: ["私密"],
      variable,
    };
  }

  private selectionVisible(selection: Selection): boolean {
    return this.visibleSections().some(
      (section) =>
        section.source === selection.source &&
        section.items.some((item) => item.id === selection.id),
    );
  }

  private firstVisibleSelection(): Selection | null {
    for (const section of this.visibleSections()) {
      const first = section.items[0];
      if (first) {
        return { source: section.source, id: first.id };
      }
    }
    return null;
  }

  private captureScrollPositions(): void {
    for (const source of listSources) {
      const list = this.root.querySelector<HTMLElement>(
        `.remember-list[data-source="${source}"]`,
      );
      if (list) {
        this.scrollPositions[source] = list.scrollTop;
      }
    }
  }

  private restoreScrollPosition(source: ListSource, list: HTMLElement): void {
    const scrollTop = this.scrollPositions[source];
    requestAnimationFrame(() => {
      const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
      list.scrollTop = Math.min(scrollTop, maxScrollTop);
    });
  }

  private restoreSearchFocus(): void {
    if (!this.focusSearchAfterRender) {
      return;
    }
    this.focusSearchAfterRender = false;
    const cursor = this.searchSelectionStart;
    requestAnimationFrame(() => {
      const search = this.root.querySelector<HTMLInputElement>(".remember-search-input");
      if (!search) {
        return;
      }
      search.focus();
      search.setSelectionRange(cursor, cursor);
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
