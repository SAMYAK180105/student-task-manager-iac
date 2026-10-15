(() => {
  "use strict";

  const API = "/api";
  const STATUSES = ["Pending", "In Progress", "Completed"];
  const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };
  const VIEW_TITLES = {
    all: "All tasks",
    Pending: "Pending tasks",
    "In Progress": "Tasks in progress",
    Completed: "Completed tasks",
  };

  const state = {
    tasks: [],
    loading: true,
    loadError: null,
    view: "all",
    search: "",
    priority: "all",
    sort: "newest",
    editingId: null,
    saving: false,
  };

  const $ = (selector) => document.querySelector(selector);
  const slug = (text) => text.toLowerCase().replace(/\s+/g, "-");

  // Builds DOM elements safely: text is always inserted as text, never as HTML.
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === false || value == null) continue;
      if (key === "class") el.className = value;
      else if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
      else el.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(child));
    }
    return el;
  }

  // ---------- API ----------
  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(API + path, {
        headers: { "Content-Type": "application/json" },
        ...options,
      });
    } catch {
      throw new Error("Cannot reach the server. Check your connection and try again.");
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      /* response had no JSON body */
    }
    if (!response.ok) {
      const error = new Error(body?.error?.message || `Request failed (${response.status})`);
      error.details = body?.error?.details || [];
      throw error;
    }
    return body;
  }

  // ---------- dates ----------
  const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
  function parseDay(value) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function isOverdue(task) {
    if (!task.deadline || task.status === "Completed") return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return parseDay(task.deadline) < today;
  }

  // ---------- derived data ----------
  function visibleTasks() {
    const term = state.search.trim().toLowerCase();
    const list = state.tasks.filter((t) => {
      if (state.view !== "all" && t.status !== state.view) return false;
      if (state.priority !== "all" && t.priority !== state.priority) return false;
      if (term && !`${t.title} ${t.category}`.toLowerCase().includes(term)) return false;
      return true;
    });
    const byDate = (a, b) => a.createdAt.localeCompare(b.createdAt);
    const sorters = {
      newest: (a, b) => byDate(b, a),
      oldest: byDate,
      title: (a, b) => a.title.localeCompare(b.title),
      priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || byDate(b, a),
      deadline: (a, b) => {
        if (!a.deadline && !b.deadline) return byDate(b, a);
        if (!a.deadline) return 1;
        if (!b.deadline) return -1;
        return a.deadline.localeCompare(b.deadline);
      },
    };
    return list.sort(sorters[state.sort]);
  }

  // ---------- rendering ----------
  function renderSummary() {
    const total = state.tasks.length;
    const count = (status) => state.tasks.filter((t) => t.status === status).length;
    const pending = count("Pending");
    const progress = count("In Progress");
    const done = count("Completed");

    $("#statTotal").textContent = total;
    $("#statPending").textContent = pending;
    $("#statProgress").textContent = progress;
    $("#statDone").textContent = done;

    document.querySelectorAll("[data-count]").forEach((el) => {
      el.textContent = el.dataset.count === "all" ? total : count(el.dataset.count);
    });

    const pct = (n) => (total === 0 ? 0 : (n / total) * 100);
    $("#segDone").style.width = `${pct(done)}%`;
    $("#segProg").style.width = `${pct(progress)}%`;
    $("#segPend").style.width = `${pct(pending)}%`;

    const caption =
      total === 0
        ? "Add your first task to see progress here."
        : `${Math.round(pct(done))}% complete: ${done} of ${total} tasks done.`;
    $("#meterCaption").textContent = caption;
    $("#meter").setAttribute("aria-label", caption);
  }

  function emptyState(title, text, actionLabel, onAction, isError = false) {
    return h(
      "div",
      { class: `state${isError ? " error" : ""}` },
      h("h2", {}, title),
      h("p", {}, text),
      actionLabel && h("button", { type: "button", class: "btn primary", onClick: onAction }, actionLabel),
    );
  }

  function taskRow(task) {
    const done = task.status === "Completed";
    const meta = [];
    if (task.category) meta.push(h("span", {}, task.category));
    if (task.deadline) {
      const label = `Due ${dateFormat.format(parseDay(task.deadline))}`;
      meta.push(h("span", { class: isOverdue(task) ? "overdue" : "" }, isOverdue(task) ? `${label} (overdue)` : label));
    }
    meta.push(h("span", {}, `Added ${dateFormat.format(new Date(task.createdAt))}`));

    const statusSelect = h(
      "select",
      {
        class: `status-select status-${slug(task.status)}`,
        "aria-label": `Status for ${task.title}`,
        onChange: (event) => changeStatus(task.id, event.target.value),
      },
      STATUSES.map((s) => h("option", { value: s, selected: s === task.status }, s)),
    );

    return h(
      "article",
      { class: `task prio-${slug(task.priority)}` },
      h(
        "div",
        { class: "task-main" },
        h("p", { class: `task-title${done ? " is-done" : ""}` }, task.title),
        h("p", { class: "task-meta" }, meta),
      ),
      h(
        "div",
        { class: "task-side" },
        h("span", { class: `tag prio-${slug(task.priority)}` }, `${task.priority} priority`),
        statusSelect,
        h("button", { type: "button", class: "btn small", onClick: () => openDialog(task) }, "Edit"),
        h("button", { type: "button", class: "btn small danger", onClick: () => removeTask(task) }, "Delete"),
      ),
    );
  }

  function renderList() {
    const container = $("#taskList");
    container.setAttribute("aria-busy", String(state.loading));
    container.replaceChildren();

    if (state.loading) {
      container.append(h("div", { class: "skeleton" }), h("div", { class: "skeleton" }), h("div", { class: "skeleton" }));
      return;
    }
    if (state.loadError) {
      container.append(emptyState("Tasks could not be loaded", state.loadError, "Try again", loadTasks, true));
      return;
    }
    if (state.tasks.length === 0) {
      container.append(
        emptyState("No tasks yet", "Add an assignment, lab report or exam to start tracking your work.", "Add your first task", () => openDialog()),
      );
      return;
    }
    const tasks = visibleTasks();
    if (tasks.length === 0) {
      container.append(emptyState("No tasks match these filters", "Change the search words or filters to see more tasks.", "Clear filters", clearFilters));
      return;
    }
    container.append(...tasks.map(taskRow));
  }

  function render() {
    renderSummary();
    renderList();
  }

  // ---------- messages ----------
  let toastTimer;
  function toast(message, isError = false) {
    const el = $("#toast");
    el.textContent = message;
    el.className = `toast${isError ? " error" : ""}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3500);
  }

  // ---------- actions ----------
  async function loadTasks() {
    state.loading = true;
    state.loadError = null;
    render();
    try {
      const body = await api("/tasks");
      state.tasks = body.data;
    } catch (error) {
      state.loadError = error.message;
    }
    state.loading = false;
    render();
  }

  async function checkHealth() {
    try {
      const body = await api("/health");
      $("#healthDot").className = "dot ok";
      $("#healthText").textContent = body.status === "ok" ? "Server online" : "Server degraded";
    } catch {
      $("#healthDot").className = "dot bad";
      $("#healthText").textContent = "Server unreachable";
    }
  }

  function replaceTask(updated) {
    state.tasks = state.tasks.map((t) => (t.id === updated.id ? updated : t));
  }

  async function changeStatus(id, status) {
    try {
      const body = await api(`/tasks/${id}`, { method: "PUT", body: JSON.stringify({ status }) });
      replaceTask(body.data);
      toast(`Status changed to ${status}`);
    } catch (error) {
      toast(error.message, true);
    }
    render();
  }

  async function removeTask(task) {
    if (!window.confirm(`Delete "${task.title}"? This cannot be undone.`)) return;
    try {
      await api(`/tasks/${task.id}`, { method: "DELETE" });
      state.tasks = state.tasks.filter((t) => t.id !== task.id);
      toast("Task deleted");
    } catch (error) {
      toast(error.message, true);
    }
    render();
  }

  function clearFilters() {
    state.search = "";
    state.priority = "all";
    state.view = "all";
    $("#search").value = "";
    $("#priorityFilter").value = "all";
    syncNav();
    render();
  }

  // ---------- add / edit dialog ----------
  const dialog = $("#taskDialog");

  function showFormError(message) {
    const el = $("#formError");
    el.textContent = message;
    el.hidden = !message;
  }

  function openDialog(task) {
    state.editingId = task ? task.id : null;
    $("#dialogTitle").textContent = task ? "Edit task" : "Add task";
    $("#fTitle").value = task ? task.title : "";
    $("#fPriority").value = task ? task.priority : "Medium";
    $("#fStatus").value = task ? task.status : "Pending";
    $("#fCategory").value = task ? task.category : "";
    $("#fDeadline").value = task && task.deadline ? task.deadline : "";
    showFormError("");
    dialog.showModal();
    $("#fTitle").focus();
  }

  async function saveTask(event) {
    event.preventDefault();
    if (state.saving) return;
    const payload = {
      title: $("#fTitle").value.trim(),
      priority: $("#fPriority").value,
      status: $("#fStatus").value,
      category: $("#fCategory").value.trim(),
      deadline: $("#fDeadline").value || null,
    };
    if (!payload.title) {
      showFormError("Enter a title for the task.");
      $("#fTitle").focus();
      return;
    }

    state.saving = true;
    $("#saveBtn").disabled = true;
    $("#saveBtn").textContent = "Saving...";
    try {
      if (state.editingId) {
        const body = await api(`/tasks/${state.editingId}`, { method: "PUT", body: JSON.stringify(payload) });
        replaceTask(body.data);
        toast("Task updated");
      } else {
        const body = await api("/tasks", { method: "POST", body: JSON.stringify(payload) });
        state.tasks = [body.data, ...state.tasks];
        toast("Task added");
      }
      dialog.close();
      render();
    } catch (error) {
      const details = error.details && error.details.length ? ` ${error.details.join(". ")}.` : "";
      showFormError(`${error.message}.${details}`);
    } finally {
      state.saving = false;
      $("#saveBtn").disabled = false;
      $("#saveBtn").textContent = "Save task";
    }
  }

  // ---------- navigation and events ----------
  function syncNav() {
    document.querySelectorAll(".nav-item").forEach((button) => {
      const active = button.dataset.view === state.view;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    $("#viewTitle").textContent = VIEW_TITLES[state.view];
  }

  document.querySelectorAll(".nav-item").forEach((button) =>
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      syncNav();
      render();
    }),
  );
  $("#addBtn").addEventListener("click", () => openDialog());
  $("#cancelBtn").addEventListener("click", () => dialog.close());
  $("#taskForm").addEventListener("submit", saveTask);
  $("#search").addEventListener("input", (event) => {
    state.search = event.target.value;
    renderList();
  });
  $("#priorityFilter").addEventListener("change", (event) => {
    state.priority = event.target.value;
    renderList();
  });
  $("#sortBy").addEventListener("change", (event) => {
    state.sort = event.target.value;
    renderList();
  });

  loadTasks();
  checkHealth();
})();
