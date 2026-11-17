import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MemoryChainSummary, RememberItem, RememberSnapshot } from "./types";

interface ChainDraft {
  id: string | null;
  name: string;
  note: string;
  values: string[];
  revealed: boolean;
}

export function mountRemember(root: HTMLElement): void {
  const controller = new RememberController(root);
  void controller.start();
}

class RememberController {
  private snapshot: RememberSnapshot | null = null;
  private selectedRecentId: string | null = null;
  private query = "";
  private searchComposing = false;
  private draft: ChainDraft | null = null;
  private busy = false;
  private status = "";

  constructor(private readonly root: HTMLElement) {
    root.className = "remember-root";
  }

  async start(): Promise<void> {
    try {
      await listen<RememberSnapshot>("deskmon-remember-changed", ({ payload }) => {
        this.snapshot = payload;
        if (!this.draft && !this.searchComposing) this.render();
      });
      await this.refresh();
    } catch (error) {
      this.showError(error);
    }
  }

  private async refresh(): Promise<void> {
    this.snapshot = await invoke<RememberSnapshot>("get_remember_snapshot");
    this.render();
  }

  private get chains(): MemoryChainSummary[] {
    const query = this.query.toLocaleLowerCase().trim();
    return (this.snapshot?.chains ?? []).filter((chain) =>
      [chain.name, chain.note ?? ""].some((value) => value.toLocaleLowerCase().includes(query)),
    );
  }

  private get recent(): RememberItem[] {
    const query = this.query.toLocaleLowerCase().trim();
    return (this.snapshot?.recent ?? []).filter((item) =>
      item.text.toLocaleLowerCase().includes(query),
    );
  }

  private render(): void {
    const scrolls = Array.from(
      this.root.querySelectorAll<HTMLElement>("[data-remember-scroll]"),
      (list) => [list.dataset.rememberScroll, list.scrollTop] as const,
    );
    const scrollPositions = new Map(scrolls);
    const oldSearch = this.root.querySelector<HTMLInputElement>(".remember-search-input");
    const searchFocused = oldSearch != null && document.activeElement === oldSearch;
    const cursor = oldSearch?.selectionStart ?? null;

    const shell = element("section", this.snapshot?.error ? "remember-shell with-error" : "remember-shell");
    const header = element("header", "remember-header");
    const title = element("div", "remember-title-block");
    const icon = element("span", "remember-title-icon");
    icon.setAttribute("aria-hidden", "true");
    title.append(icon, element("h1", "", "回忆"));
    header.append(title);

    const toolbar = element("div", "remember-toolbar");
    const searchBox = element("div", "remember-search");
    const search = element("input", "remember-search-input");
    search.type = "search";
    search.placeholder = "搜索记忆链或记忆中";
    search.setAttribute("aria-label", search.placeholder);
    search.value = this.query;
    const updateSearch = () => {
      if (this.query === search.value) return;
      this.query = search.value;
      this.selectedRecentId = null;
      this.render();
    };
    search.addEventListener("compositionstart", () => { this.searchComposing = true; });
    search.addEventListener("compositionend", () => {
      this.searchComposing = false;
      updateSearch();
    });
    search.addEventListener("input", () => {
      if (!this.searchComposing) updateSearch();
    });
    search.addEventListener("keydown", (event) => {
      if (event.isComposing || event.key !== "Enter" || this.draft) return;
      const [chain] = this.chains;
      if (chain) {
        event.preventDefault();
        void this.useChain(chain.id);
      }
    });
    const searchIcon = element("span", "remember-search-icon");
    searchIcon.setAttribute("aria-hidden", "true");
    searchBox.append(searchIcon, search);
    toolbar.append(searchBox, button("新建记忆链", "primary-button remember-add-chain", () => this.newChain()));

    shell.append(header, toolbar);
    if (this.snapshot?.error) {
      const error = element("div", "remember-error");
      error.append(element("p", "", this.snapshot.error), button("重置记忆链", "danger-button", () =>
        this.change("remember_reset_chains", {}),
      ));
      shell.append(error);
    }

    const layout = element("main", "remember-layout");
    const list = element("div", "remember-list-pane");
    const chains = this.chains;
    const recent = this.recent;
    list.append(
      this.section("chains", "记忆链", chains.length, this.snapshot?.chainLimit, chains.map((chain) => this.chainRow(chain))),
      this.section("recent", "记忆中", recent.length, this.snapshot?.recentLimit, recent.map((item) => this.recentRow(item))),
    );

    const detail = element("section", "remember-detail-pane");
    detail.append(this.renderDetail());
    const status = element("p", "remember-status error", this.status);
    status.setAttribute("role", "alert");
    detail.append(status);
    layout.append(list, detail);
    shell.append(layout);
    this.root.replaceChildren(shell);

    for (const node of this.root.querySelectorAll<HTMLElement>("[data-remember-scroll]")) {
      node.scrollTop = scrollPositions.get(node.dataset.rememberScroll) ?? 0;
    }
    if (searchFocused) {
      search.focus();
      if (cursor !== null) search.setSelectionRange(cursor, cursor);
    }
  }

  private section(
    source: "chains" | "recent",
    title: string,
    count: number,
    limit: number | undefined,
    rows: HTMLElement[],
  ): HTMLElement {
    const section = element("section", `remember-section ${source}${count ? "" : " empty"}`);
    const header = element("header", "remember-section-header");
    const label = element("div", "remember-section-title");
    label.append(element("h2", "", title), element("p", "", `${count}/${limit ?? (source === "chains" ? 50 : 10)}`));
    header.append(label);
    section.append(header);
    if (rows.length) {
      const list = element("div", "remember-list");
      list.dataset.rememberScroll = source;
      list.append(...rows);
      section.append(list);
    } else {
      section.append(element("p", "remember-empty", this.query.trim() ? "没有匹配的内容" : "还没有"));
    }
    return section;
  }

  private chainRow(chain: MemoryChainSummary): HTMLElement {
    const row = element("article", "remember-row chain");
    const pick = this.rowButton(chain.name, `${chain.valueCount} 条内容`, "chain", () => this.useChain(chain.id));
    pick.title = "选择后按 ⌘V 顺序粘贴";
    if (chain.pinned) pick.append(element("span", "remember-row-chip", "置顶"));
    row.append(pick, this.rowActions(
      button("编辑", "remember-row-action", () => this.editChain(chain)),
      button(chain.pinned ? "取消置顶" : "置顶", "remember-row-action", () =>
        this.change("remember_set_chain_pinned", { id: chain.id, pinned: !chain.pinned }),
      ),
      button("删除", "remember-row-action danger", () => this.change("remember_delete_chain", { id: chain.id })),
    ));
    return row;
  }

  private recentRow(item: RememberItem): HTMLElement {
    const selected = this.selectedRecentId === item.id && !this.draft;
    const row = element("article", `remember-row recent${selected ? " selected" : ""}`);
    const pick = this.rowButton(item.preview, item.truncated ? "已截断" : "", "recent", () => {
      this.draft = null;
      this.selectedRecentId = item.id;
      this.status = "";
      this.render();
    });
    pick.setAttribute("aria-pressed", String(selected));
    row.append(pick, this.rowActions(
      button("复制", "remember-row-action", () => this.change("remember_copy_recent", { id: item.id })),
      button("存为记忆链", "remember-row-action", () => this.newChain(item.text)),
      button("忘记", "remember-row-action danger", () => this.change("remember_forget_recent", { id: item.id })),
    ));
    return row;
  }

  private rowButton(title: string, subtitle: string, source: string, action: () => void | Promise<void>): HTMLButtonElement {
    const pick = button("", "remember-row-main", action);
    const copy = element("span", "remember-row-copy");
    copy.append(element("span", "remember-row-preview", title));
    if (subtitle) copy.append(element("span", "remember-row-meta", subtitle));
    pick.append(element("span", `remember-row-source ${source}`), copy);
    return pick;
  }

  private rowActions(...buttons: HTMLButtonElement[]): HTMLElement {
    const actions = element("div", "remember-row-actions");
    actions.append(...buttons);
    return actions;
  }

  private renderDetail(): HTMLElement {
    if (this.draft) return this.renderEditor(this.draft);
    const recent = this.recent.find((item) => item.id === this.selectedRecentId);
    if (recent) {
      const detail = element("div", "remember-detail-content recent-detail");
      const header = element("header", "remember-detail-header");
      header.append(element("h2", "", "记忆中"));
      const text = element("pre", "remember-text", recent.text);
      detail.append(header, text);
      return detail;
    }
    const empty = element("div", "remember-detail-empty");
    if (this.chains.length) {
      empty.append(element("h2", "", "选择一条记忆链"));
      empty.append(element("p", "", "回到输入框后，每按一次 ⌘V 就粘贴下一条。"));
    } else if (!this.query.trim()) {
      empty.append(element("h2", "", "新建一条记忆链"));
      empty.append(element("p", "", "把需要依次粘贴的内容放在一起。"));
    }
    return empty;
  }

  private renderEditor(draft: ChainDraft): HTMLFormElement {
    const form = element("form", "remember-chain-form");
    form.append(element("h2", "", draft.id ? "编辑记忆链" : "新建记忆链"));

    const name = element("input", "remember-form-input");
    name.required = true;
    name.autocomplete = "off";
    name.value = draft.name;
    name.addEventListener("input", () => { draft.name = name.value; });
    form.append(labeled("名称", name));

    const note = element("input", "remember-form-input");
    note.value = draft.note;
    note.addEventListener("input", () => { draft.note = note.value; });
    form.append(labeled("备注（可选）", note));

    const controls = element("div", "remember-chain-controls");
    const reveal = element("input");
    reveal.type = "checkbox";
    reveal.checked = draft.revealed;
    reveal.addEventListener("change", () => {
      draft.revealed = reveal.checked;
      form.classList.toggle("show-values", draft.revealed);
    });
    const revealLabel = element("label");
    revealLabel.append(reveal, document.createTextNode("显示内容"));
    controls.append(element("h3", "", "粘贴顺序"), revealLabel);
    form.append(controls);
    form.classList.toggle("show-values", draft.revealed);

    const values = element("ol", "remember-chain-values");
    for (const [index, value] of draft.values.entries()) {
      const row = element("li", "remember-chain-value");
      const text = element("textarea", "remember-form-textarea compact");
      text.required = true;
      text.spellcheck = false;
      text.value = value;
      text.addEventListener("input", () => { draft.values[index] = text.value; });
      const actions = element("div", "remember-chain-controls");
      const move = (offset: number) => {
        const target = index + offset;
        [draft.values[index], draft.values[target]] = [draft.values[target], draft.values[index]];
        this.render();
        this.focusValue(target);
      };
      const up = button("上移", "subtle-button", () => move(-1));
      const down = button("下移", "subtle-button", () => move(1));
      const remove = button("移除", "subtle-button", () => {
        draft.values.splice(index, 1);
        this.render();
        this.focusValue(Math.min(index, draft.values.length - 1));
      });
      up.disabled = index === 0;
      down.disabled = index === draft.values.length - 1;
      remove.disabled = draft.values.length === 1;
      actions.append(up, down, remove);
      row.append(labeled(`第 ${index + 1} 条`, text), actions);
      values.append(row);
    }
    form.append(values);
    form.append(button("添加一条", "subtle-button", () => {
      draft.values.push("");
      this.render();
      this.focusValue(draft.values.length - 1);
    }));

    const actions = element("div", "remember-form-actions");
    const save = element("button", "primary-button", "保存");
    save.type = "submit";
    save.disabled = this.busy;
    actions.append(button("取消", "subtle-button", () => {
      this.draft = null;
      this.status = "";
      this.render();
    }), save);
    form.append(actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.saveChain(draft, save);
    });
    return form;
  }

  private newChain(initial = ""): void {
    if (this.busy) return;
    this.status = "";
    this.draft = { id: null, name: "", note: "", values: [initial], revealed: false };
    this.render();
    this.root.querySelector<HTMLInputElement>(".remember-chain-form input")?.focus();
  }

  private async editChain(chain: MemoryChainSummary): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const values = await invoke<string[]>("remember_chain_values", { id: chain.id });
      this.draft = { id: chain.id, name: chain.name, note: chain.note ?? "", values, revealed: false };
      this.status = "";
      this.render();
      this.root.querySelector<HTMLInputElement>(".remember-chain-form input")?.focus();
    } catch (error) {
      this.showError(error);
    } finally {
      this.busy = false;
      const save = this.root.querySelector<HTMLButtonElement>(".remember-chain-form button[type=submit]");
      if (save) save.disabled = false;
    }
  }

  private focusValue(index: number): void {
    this.root.querySelectorAll<HTMLTextAreaElement>(".remember-chain-value textarea")[index]?.focus();
  }

  private async saveChain(draft: ChainDraft, save: HTMLButtonElement): Promise<void> {
    if (this.busy) return;
    this.busy = save.disabled = true;
    try {
      this.snapshot = await invoke<RememberSnapshot>("remember_save_chain", {
        id: draft.id,
        name: draft.name,
        note: draft.note,
        values: draft.values,
      });
      this.draft = null;
      this.status = "";
      this.render();
    } catch (error) {
      this.showError(error);
    } finally {
      this.busy = save.disabled = false;
    }
  }

  private async useChain(id: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await invoke("remember_use_chain", { id });
      this.draft = null;
      this.status = "";
      this.render();
    } catch (error) {
      this.showError(error);
    } finally {
      this.busy = false;
    }
  }

  private async change(command: string, args: Record<string, unknown>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.snapshot = await invoke<RememberSnapshot>(command, args);
      this.status = "";
      this.render();
    } catch (error) {
      this.showError(error);
    } finally {
      this.busy = false;
    }
  }

  private showError(error: unknown): void {
    this.status = String(error);
    const status = this.root.querySelector(".remember-status");
    if (status) status.textContent = this.status;
    else this.render();
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K, className = "", content = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content) node.textContent = content;
  return node;
}

function button(
  label: string, className: string, action: () => void | Promise<void>,
): HTMLButtonElement {
  const node = element("button", className, label);
  node.type = "button";
  node.addEventListener("click", () => { void action(); });
  return node;
}

function labeled(label: string, field: HTMLElement): HTMLLabelElement {
  const node = element("label", "remember-form-field");
  node.append(element("span", "remember-detail-label", label), field);
  return node;
}
