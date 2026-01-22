import { getPageContentHTML } from "../utils.js";
import { renderModal, closeModal } from "../components/modal.js";
import { state as appState } from "../state.js";
import { apiBase } from "../config.js";

// // ROLE CHECKER
// function getUserRole() {
//   return localStorage.getItem("role") || "L1";
// }

// function isEmployee() {
//   return getUserRole() === "L1";
// }

// function isManagerOrAdmin() {
//   const role = getUserRole();
//   return role === "L2" || role === "L3";
// }

const LS_KEY = "tt_projects_v1";
const API_ROOT = apiBase.replace(/\/$/, "");
const API_BASE = API_ROOT; // backward compatibility for existing calls below
const PROJECTS_API = `${API_ROOT}/api/projects`;
let projectsCache = [];
let projectsViewMode = "table";
const listState = {
  page: 1,
  pageSize: 10,
  sort: { by: "name", dir: "asc" },
};

// ---------------------- Bulk Upload (CSV) ----------------------
const parseProjectsCSV = (text) => {
  const rows = (text || "")
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .split(",")
        .map((c) => c.replace(/^\ufeff/, "").replace(/^"|"$/g, "").trim())
    );
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.toLowerCase());
  const idx = {
    name: header.findIndex((h) => ["name", "project name", "project_name"].includes(h)),
    code: header.findIndex((h) => ["code", "project code", "project_code", "id", "projectid"].includes(h)),
    client: header.findIndex((h) => ["client", "client name", "client_name"].includes(h)),
    status: header.findIndex((h) => ["status"].includes(h)),
    start: header.findIndex((h) => ["start", "start_date", "start date"].includes(h)),
    end: header.findIndex((h) => ["end", "end_date", "end date"].includes(h)),
    contributors: header.findIndex((h) =>
      ["contributors", "number of contributors", "num_contributors", "noofcontributors"].includes(h)
    ),
  };
  const data = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.length) continue;
    const get = (j) => (j >= 0 ? row[j] || "" : "");
    data.push({
      name: get(idx.name),
      code: get(idx.code),
      client: get(idx.client),
      status: get(idx.status) || "Active",
      start_date: get(idx.start),
      end_date: get(idx.end),
      contributors: get(idx.contributors),
    });
  }
  return data.filter((r) => r.name || r.code || r.client);
};

const showProjectBulkUploadModal = () => {
  const formHTML = `
    <div class="form-group" style="display:flex; flex-direction:column; gap:10px;">
      <div style="display:flex; flex-direction:column; gap:6px;">
        <label for="proj-csv-file" style="font-weight:600;">Upload CSV</label>
        <input type="file" id="proj-csv-file" accept=".csv" style="padding:10px; border-radius:10px; border:1px solid var(--border-color);" />
        <small style="color:#64748b;">Columns: name, code, client, status, start_date, end_date, contributors</small>
      </div>
      <div id="proj-upload-preview" style="max-height:220px; overflow:auto; padding:12px; border:1px dashed var(--border-color); border-radius:12px; background:#f8fafc;"></div>
    </div>
  `;
  renderModal("Bulk Upload Projects", formHTML, "proj-upload-submit", "normal", "Upload");
  const form = document.getElementById("modal-form");
  if (form) {
    form.addEventListener("submit", handleProjectBulkUpload);
  }
  const fileInput = document.getElementById("proj-csv-file");
  if (fileInput) {
    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      const rows = parseProjectsCSV(text);
      const preview = document.getElementById("proj-upload-preview");
      if (preview) {
        if (!rows || !rows.length) {
          preview.innerHTML = "<div style='color:#475569;'>No rows detected.</div>";
        } else {
          const header = `<div style="font-weight:600; margin-bottom:6px; color:#0f172a;">Preview (first 5 rows)</div>`;
          const table = `
            <table style="width:100%; border-collapse:collapse; font-size:12px; color:#0f172a;">
              <thead>
                <tr style="background:#e2e8f0;">
                  <th style="text-align:left; padding:6px; border:1px solid #cbd5e1;">#</th>
                  <th style="text-align:left; padding:6px; border:1px solid #cbd5e1;">Name</th>
                  <th style="text-align:left; padding:6px; border:1px solid #cbd5e1;">Code</th>
                  <th style="text-align:left; padding:6px; border:1px solid #cbd5e1;">Client</th>
                  <th style="text-align:left; padding:6px; border:1px solid #cbd5e1;">Status</th>
                </tr>
              </thead>
              <tbody>
                ${rows
                  .slice(0, 5)
                  .map(
                    (r, idx) => `
                      <tr>
                        <td style="padding:6px; border:1px solid #e2e8f0;">${idx + 1}</td>
                        <td style="padding:6px; border:1px solid #e2e8f0;">${r.name || ""}</td>
                        <td style="padding:6px; border:1px solid #e2e8f0;">${r.code || ""}</td>
                        <td style="padding:6px; border:1px solid #e2e8f0;">${r.client || ""}</td>
                        <td style="padding:6px; border:1px solid #e2e8f0;">${r.status || ""}</td>
                      </tr>
                    `
                  )
                  .join("")}
              </tbody>
            </table>
            ${rows.length > 5 ? `<div style="margin-top:8px; color:#64748b;">…and ${rows.length - 5} more</div>` : ""}
          `;
          preview.innerHTML = header + table;
        }
      }
    });
  }
};

const handleProjectBulkUpload = async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById("proj-csv-file");
  const file = fileInput?.files?.[0];
  if (!file) {
    alert("Please select a CSV file");
    return;
  }
  let rows = [];
  try {
    const text = await file.text();
    rows = parseProjectsCSV(text);
  } catch (err) {
    console.error("Failed to read CSV", err);
    alert("Could not read the CSV file.");
    return;
  }
  if (!rows.length) {
    alert("No valid project rows found in CSV.");
    return;
  }
  try {
    // Map CSV rows to backend field names
    const payloadProjects = rows.map((r) => {
      const code = (r.code || "").trim();
      const name = (r.name || "").trim();
      const client = (r.client || "").trim();
      const status = (r.status || "Active").trim() || "Active";
      const start = (r.start_date || "").trim();
      const end = (r.end_date || "").trim();
      const contrib = Number(r.contributors || 0) || 0;
      return {
        crc6f_projectid: code,
        crc6f_projectname: name,
        crc6f_client: client,
        crc6f_projectstatus: status,
        crc6f_startdate: start,
        crc6f_enddate: end,
        crc6f_noofcontributors: contrib,
      };
    });

    const resp = await fetch(`${PROJECTS_API}/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projects: payloadProjects }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.success) {
      const errText = data.error || data.message || `Bulk upload failed with status ${resp.status}`;
      throw new Error(errText);
    }
    const created = data.created ?? rows.length;
    const errors = Array.isArray(data.errors) ? data.errors : [];
    await fetchProjects(); // refresh list
    closeModal();
    if (errors.length) {
      const detail = errors
        .map((e) => `Row ${e.index || "?"}: ${e.projectid || ""} - ${e.error || "error"}`)
        .join("\n");
      alert(`Uploaded ${created} projects. ${errors.length} skipped:\n${detail}`);
    } else {
      alert(`Uploaded ${created} projects`);
    }
  } catch (err) {
    console.error("Bulk upload failed", err);
    alert(`Bulk upload failed: ${err.message || err}`);
  }
};

const getProjectAccess = () => {
  try {
    const rawRole = (
      appState?.user?.role ||
      window?.state?.user?.role ||
      localStorage.getItem("role") ||
      ""
    )
      .toString()
      .trim();
    const normalizedRole = rawRole ? rawRole.toUpperCase() : "";
    const hasAdminFlag = !!(appState?.user?.is_admin || window?.state?.user?.is_admin);
    const hasManagerFlag = !!(appState?.user?.is_manager || window?.state?.user?.is_manager);
    const designation = (appState?.user?.designation || "").toString().toLowerCase();
    const derivedRole =
      normalizedRole ||
      (hasAdminFlag ? "L3" : "") ||
      (hasManagerFlag ? "L2" : "") ||
      (designation.includes("manager") ? "L2" : "") ||
      (designation.includes("hr") ? "L3" : "") ||
      "L1";
    const isAdmin = hasAdminFlag || ["L3", "ADMIN"].includes(derivedRole);
    const isManager = hasManagerFlag || ["L2", "MANAGER"].includes(derivedRole);
    return { role: derivedRole, canManage: isAdmin || isManager };
  } catch {
    return { role: "L1", canManage: false };
  }
};

const seedIfEmpty = () => {
  const raw = localStorage.getItem(LS_KEY);
  if (raw) return JSON.parse(raw);
  const demo = [
    {
      id: "VTAB001",
      name: "Amber - West Coast",
      code: "VTAB 001",
      client: "Amber Group",
      contributors: 9,
      status: "Active",
      start: "11 Jun 2025",
      end: "",
    },
    {
      id: "VTAB003",
      name: "Vtab Internal Tasks",
      code: "VTAB 003",
      client: "Vtab Internal",
      contributors: 21,
      status: "Active",
      start: "",
      end: "",
    },
    {
      id: "VTAB004",
      name: "Amber - Fidelity",
      code: "VTAB 004",
      client: "Amber Group",
      contributors: 8,
      status: "Active",
      start: "",
      end: "",
    },
    {
      id: "VTAB003X",
      name: "Projects From Nagesal Iyer",
      code: "VTAB003",
      client: "Vtab Internal",
      contributors: 1,
      status: "Inactive",
      start: "",
      end: "",
    },
    {
      id: "VTAB005",
      name: "Amber - Canopy",
      code: "VTAB 005",
      client: "Amber Group",
      contributors: 7,
      status: "Active",
      start: "7 Aug 2025",
      end: "",
    },
    {
      id: "VTAB006",
      name: "Amber - Proven",
      code: "VTAB 006",
      client: "Amber Group",
      contributors: 5,
      status: "Active",
      start: "8 Aug 2025",
      end: "",
    },
    {
      id: "VTAB007",
      name: "Project Python Development",
      code: "VTAB 007",
      client: "Vtab Internal",
      contributors: 12,
      status: "Active",
      start: "25 Sept 2025",
      end: "",
    },
  ];
  localStorage.setItem(LS_KEY, JSON.stringify(demo));
  return demo;
};

const load = () => {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "[]");
  } catch {
    return [];
  }
};

const compare = (a, b, by) => {
  const va = (a?.[by] ?? "").toString().toLowerCase();
  const vb = (b?.[by] ?? "").toString().toLowerCase();
  if (va < vb) return -1;
  if (va > vb) return 1;
  return 0;
};

const renderList = () => {
  const items = projectsCache.slice();
  const sorted = items.slice().sort((a, b) => {
    const s = compare(a, b, listState.sort.by);
    return listState.sort.dir === "asc" ? s : -s;
  });
  const start = (listState.page - 1) * listState.pageSize;
  const pageItems = sorted.slice(start, start + listState.pageSize);
  const total = items.length;

  const isTableMode = projectsViewMode === "table";

  const th = (k, label) =>
    `<th><button class="link like-th" data-sort="${k}">${label} ${listState.sort.by === k
      ? listState.sort.dir === "asc"
        ? "\u2191"
        : "\u2193"
      : ""
    }</button></th>`;

  const rows = pageItems
    .map(
      (p) => `
    <tr>
      <td class="project-link" data-id="${p.id}">${p.name || ""}</td>
      <td>${p.code || ""}</td>
      <td>${p.client || ""}</td>
      <td>${p.contributors || 0}</td>
      <td><span class="status-badge ${String(p.status || "").toLowerCase()}">${p.status || ""
        }</span></td>
      <td>${p.start || "."}</td>
      <td>${p.end || "."}</td>
      <td class="actions-cell">
        <button class="icon-btn action-btn delete proj-del" data-id="${p._recordId
        }"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>
  `
    )
    .join("");

  const cards = pageItems
    .map(
      (p) => `
      <div class="project-card">
        <div class="project-card-header">
          <div class="project-card-main">
            <button class="project-link as-text" data-id="${p.id}">
              ${p.name || ""}
            </button>
            <div class="project-card-meta">
              <span class="project-code">${p.code || ""}</span>
              <span class="dot-separator">•</span>
              <span class="project-client">${p.client || ""}</span>
            </div>
          </div>
          <span class="status-badge ${String(p.status || "").toLowerCase()}">${p.status || ""
        }</span>
        </div>
        <div class="project-card-body">
          <div class="project-card-stat">
            <span class="label">Contributors</span>
            <span class="value">${p.contributors || 0}</span>
          </div>
          <div class="project-card-stat">
            <span class="label">Start date</span>
            <span class="value">${p.start || "."}</span>
          </div>
          <div class="project-card-stat">
            <span class="label">End date</span>
            <span class="value">${p.end || "."}</span>
          </div>
        </div>
        <div class="project-card-footer">
          <button class="icon-btn action-btn delete proj-del" data-id="${p._recordId
        }"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>
    `
    )
    .join("");

  const cardsMarkup =
    cards ||
    `<div class="placeholder-text">No projects found. Click ADD NEW to create one.</div>`;
  //       <button id="proj-add" class="btn btn-primary">ADD NEW</button>
  //       <button id="proj-filter" class="btn btn-secondary" title="Filter"><i class="fa-solid fa-filter"></i></button>
  //       <button id="proj-more" class="btn btn-secondary" title="More"><i class="fa-solid fa-ellipsis-vertical"></i></button>
  //     </div>
  //   </div>`;

  const content = `
    <style>
      .projects-page{ max-width:1400px; min-width:800px; width:100%; margin:0 auto; }
      .subheader{ background: var(--primary-color); color:#fff; padding:14px 16px; border-radius:10px; display:flex; align-items:center; justify-content:space-between; box-shadow:0 1px 0 rgba(0,0,0,.05) inset; }
      .subheader .crumb{ font-weight:600; font-size:16px; }
      .card.projects-table{ margin-top:12px; width: 100%; }
      .table thead th{ text-transform:uppercase; font-size:12px; color: var(--text-secondary); letter-spacing:.4px; }
      .table thead th{ vertical-align: middle; }
      .table thead th .like-th{
        background:none; border:none; padding:0; margin:0; color:inherit; font:inherit; text-transform:inherit;
        cursor:pointer; display:inline-flex; align-items:center; gap:6px;
      }
      .table thead th .like-th:focus{ outline:none; box-shadow:none; }
      .table td, .table th{ padding:16px 20px; }
      .table tr:hover{ background:#f9f9f9; }
      .actions-cell{
        text-align:center;
        width:120px;
        white-space:nowrap;
      }
      .actions-cell .icon-btn{
        display:inline-flex;
        align-items:center;
        justify-content:center;
        margin:0 4px;
      }
      /* rely on global .status-badge colors from index.css */
      .status-badge{ padding:4px 8px; border-radius:999px; font-size:12px; font-weight:600; }
      .projects-toolbar{ display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:12px; }
      .projects-toolbar-left{ display:flex; align-items:center; gap:12px; }
      .projects-toolbar-actions{ display:inline-flex; align-items:center; gap:10px; }
      .projects-view-toggle{ display:inline-flex; gap:4px; }
      .pagination-bar{ 
        display:flex; 
        flex-direction:column; 
        align-items:center; 
        gap:8px; 
        padding:12px 16px; 
        border-top:1px solid var(--border-color); 
      }
      .pagination-bar-top{
        width:100%;
        display:flex;
        justify-content:space-between;
        align-items:center;
        flex-wrap:wrap;
        gap:8px;
        color:#6b7280;
        font-size:0.8rem;
      }
      .pagination-items-per-page{
        display:flex;
        align-items:center;
        gap:8px;
        font-size:0.75rem;
      }
      .pagination-items-per-page span{
        white-space:nowrap;
      }
      .pagination-summary{
        text-align:right;
      }
      .pagination-bar select{ padding:6px 10px; border:1px solid var(--border-color); border-radius:6px; }
      /* Fixed-height outer Projects card; inner content scrolls */
      .projects-table{ display:flex; flex-direction:column; height: 520px; box-sizing: border-box; }
      .projects-table:hover{ transform: none !important; scale: none !important; }
      .projects-view-wrapper{ margin-top:8px; flex:1; overflow-y:auto; }
      /* Keep outer projects card static; only inner view containers switch */
      .projects-view-wrapper .view-mode{ display:none; opacity:1; transform:none; transition:none; width: 100%; }
      .projects-view-wrapper .view-mode.view-mode-visible{ display:block; width: 100%; }
      /* Projects cards grid – 2-3 cards per row */
      .projects-card-grid{ 
        display:grid; 
        grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); 
        gap:20px; 
        width: 100%; 
      }
      @media (max-width: 900px){ .projects-card-grid{ grid-template-columns:1fr; } }
      .projects-card-grid.view-mode.view-mode-visible{ display:grid; width: 100%; }
      /* Project cards styled like onboarding/employee cards */
      .project-card{
        background: var(--surface-color);
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 16px;
        padding: 1.5rem;
        box-shadow: 0 12px 30px rgba(15, 23, 42, 0.06);
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        min-height: 180px;
        transition: transform 0.25s ease, box-shadow 0.25s ease;
      }

      .project-card:hover{
        transform: translateY(-2px);
        box-shadow: 0 16px 35px rgba(15, 23, 42, 0.1);
      }
      .project-card-header{ display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
      .project-card-main{ display:flex; flex-direction:column; gap:2px; }
      .project-card-title{ font-weight:600; font-size:0.95rem; color:var(--text-primary); }
      .project-card-meta{ font-size:0.8rem; color:var(--text-muted); }
      .project-card-body{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; font-size:0.8rem; }
      .project-card-stat .label{ display:block; color:var(--text-muted); }
      .project-card-stat .value{ font-weight:500; color:var(--text-primary); }
      .project-card-footer{ margin-top:4px; display:flex; justify-content:flex-end; gap:6px; }
      .project-link.as-text{ background:none; border:none; padding:0; margin:0; cursor:pointer; color:inherit; font:inherit; text-align:left; }
    </style>
    <div class="projects-page">
      <div class="card projects-table highlighted">
      <div class="projects-toolbar">
        <div class="projects-toolbar-left">
          <h2 style="font-size: 20px; font-weight: 600;">Projects</h2>
          <div class="projects-view-toggle" aria-label="Toggle projects view">
            <button id="projects-card-view-btn" class="view-toggle-btn ${isTableMode ? "" : "active"
    }" title="Card view">
              <i class="fa-solid fa-grip"></i>
            </button>
            <button id="projects-table-view-btn" class="view-toggle-btn ${isTableMode ? "active" : ""
    }" title="Table view">
              <i class="fa-solid fa-table"></i>
            </button>
          </div>
        </div>
        <div class="projects-toolbar-actions">
          <button id="proj-add" class="btn btn-light" style="background: white; color: var(--primary-color); font-weight: 600; border-radius: 8px;">ADD NEW</button>
          <button id="proj-bulk-upload" class="btn btn-secondary" title="Bulk upload CSV"><i class="fa-solid fa-upload"></i></button>
        </div>
      </div>
        <div class="projects-view-wrapper">
          <div id="projects-card-view" class="projects-card-grid view-mode ${isTableMode ? "" : "view-mode-visible"
    }">
            ${cardsMarkup}
          </div>
          <div id="projects-table-view" class="view-mode ${isTableMode ? "view-mode-visible" : ""
    }">
            <div class="table-container">
              <table class="table">
                <thead>
                  <tr>
                    ${th("name", "Project name")}
                    ${th("code", "Project code")}
                    ${th("client", "Client name")}
                    <th>Number of contributors</th>
                    ${th("status", "Status")}
                    ${th("start", "Start date")}
                    ${th("end", "End date")}
                    <th class="actions-col"></th>
                  </tr>
                </thead>
                <tbody>
                  ${rows ||
    `<tr><td colspan="8" class="placeholder-text">No projects found. Click ADD NEW to create one.</td></tr>`
    }
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div class="pagination-bar">
          <div class="pagination-bar-top">
            <div class="pagination-summary">
              Showing <strong>${Math.min(total, start + 1)}-${Math.min(
      total,
      start + pageItems.length
    )}</strong> of <strong>${total}</strong>
            </div>
          </div>
          <div class="pagination">
            <button id="proj-prev" class="btn btn-light" ${listState.page <= 1 ? "disabled" : ""
    }><i class="fa-solid fa-chevron-left"></i> Prev</button>
            <span class="page-indicator">Page ${listState.page} of ${total === 0
      ? 1
      : Math.max(1, Math.ceil(total / listState.pageSize || 10))
    }</span>
            <button id="proj-next" class="btn btn-light" ${start + pageItems.length >= total ? "disabled" : ""
    }>Next <i class="fa-solid fa-chevron-right"></i></button>
          </div>
          <div class="pagination-items-per-page" style="margin-top:8px; justify-content:center;">
            <span>Items per page</span>
            <select id="proj-ipp">
              <option ${listState.pageSize === 10 ? "selected" : ""}>10</option>
              <option ${listState.pageSize === 20 ? "selected" : ""}>20</option>
              <option ${listState.pageSize === 50 ? "selected" : ""}>50</option>
            </select>
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById("app-content").innerHTML = getPageContentHTML(
    "Projects",
    content,
    ""
  );

  // view toggle events
  const projCardBtn = document.getElementById("projects-card-view-btn");
  const projTableBtn = document.getElementById("projects-table-view-btn");
  const projCardView = document.getElementById("projects-card-view");
  const projTableView = document.getElementById("projects-table-view");
  if (projCardBtn && projTableBtn && projCardView && projTableView) {
    const applyProjViewState = (target) => {
      const showTable = target === "table";
      projectsViewMode = showTable ? "table" : "card";
      projCardBtn.classList.toggle("active", !showTable);
      projTableBtn.classList.toggle("active", showTable);
      projCardView.classList.toggle("view-mode-visible", !showTable);
      projTableView.classList.toggle("view-mode-visible", showTable);
    };
    projCardBtn.addEventListener("click", () => applyProjViewState("card"));
    projTableBtn.addEventListener("click", () => applyProjViewState("table"));
    applyProjViewState(projectsViewMode);
  }

  // events
  const ipp = document.getElementById("proj-ipp");
  if (ipp)
    ipp.onchange = (e) => {
      listState.pageSize = parseInt(e.target.value, 10) || 10;
      listState.page = 1;
      renderList();
    };
  const prev = document.getElementById("proj-prev");
  if (prev)
    prev.onclick = () => {
      if (listState.page > 1) {
        listState.page--;
        renderList();
      }
    };
  const next = document.getElementById("proj-next");
  if (next)
    next.onclick = () => {
      listState.page++;
      renderList();
    };
  document.querySelectorAll(".like-th").forEach((el) => {
    el.addEventListener("click", (e) => {
      const k = e.currentTarget.getAttribute("data-sort");
      if (listState.sort.by === k)
        listState.sort.dir = listState.sort.dir === "asc" ? "desc" : "asc";
      listState.sort.by = k;
      renderList();
    });
  });
  const { canManage } = getProjectAccess();

  const addBtn = document.getElementById("proj-add");
  if (addBtn) {
    if (!canManage) {
      addBtn.style.display = "none";
    } else {
      addBtn.addEventListener("click", () => showProjectModal());
    }
  }
  const bulkUploadBtn = document.getElementById("proj-bulk-upload");
  if (bulkUploadBtn) {
    bulkUploadBtn.addEventListener("click", () => showProjectBulkUploadModal());
  }

  document.querySelectorAll(".proj-edit").forEach((btn) => {
    if (!canManage) {
      btn.style.display = "none";
      return;
    }
    btn.addEventListener("click", () => {
      const recId = btn.getAttribute("data-id");
      const proj = projectsCache.find((x) => x._recordId === recId);
      showProjectModal(proj);
    });
  });

  document.querySelectorAll(".proj-del").forEach((btn) => {
    if (!canManage) {
      btn.style.display = "none";
      return;
    }
    btn.addEventListener("click", async () => {
      const recId = btn.getAttribute("data-id");
      console.log("Delete button clicked, recordId:", recId);
      console.log("Button element:", btn);
      console.log("Project data for this record:", projectsCache.find(p => p._recordId === recId));
      await handleDeleteProject(recId);
    });
  });

  const actionsHeader = document.querySelector(".actions-col");
  if (actionsHeader) actionsHeader.style.display = canManage ? "" : "none";
  document.querySelectorAll(".actions-cell").forEach((cell) => {
    cell.style.display = canManage ? "" : "none";
  });


  // Make project rows clickable
  document.querySelectorAll(".project-link").forEach((td) => {
    td.addEventListener("click", (e) => {
      const projectId = e.currentTarget.getAttribute("data-id");
      window.location.hash = `#/time-projects?id=${encodeURIComponent(
        projectId
      )}&tab=details`;
    });
  });

  document.querySelectorAll(".project-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".proj-edit, .proj-del")) return;
      const link = card.querySelector(".project-link");
      if (!link) return;
      const projectId = link.getAttribute("data-id");
      if (!projectId) return;
      window.location.hash = `#/time-projects?id=${encodeURIComponent(
        projectId
      )}&tab=details`;
    });
  });
};

// expose bulk upload helpers globally (for click handlers)
window.showProjectBulkUploadModal = showProjectBulkUploadModal;
window.handleProjectBulkUpload = handleProjectBulkUpload;

const getQuery = () => {
  const h = window.location.hash || "#/time-projects";
  const q = {};
  const i = h.indexOf("?");
  if (i >= 0)
    h.slice(i + 1)
      .split("&")
      .forEach((kv) => {
        const [k, v] = kv.split("=");
        q[decodeURIComponent(k)] = decodeURIComponent(v || "");
      });
  return q;
};

// Remove legacy demo seeding to avoid stale project lists; rely on backend fetch instead.

// ---------- Backend integration ----------
async function fetchProjects() {
  try {
    const res = await fetch(PROJECTS_API);
    const data = await res.json();
    const list = (data && data.projects) || [];
    // map to UI shape
    projectsCache = list.map((r) => ({
      _recordId: r.crc6f_hr_projectheaderid,
      id: r.crc6f_projectid,
      name: r.crc6f_projectname,
      code: r.crc6f_projectid,
      client: r.crc6f_client,
      contributors: Number(r.crc6f_noofcontributors || 0),
      status: r.crc6f_projectstatus,
      start: r.crc6f_startdate || ".",
      end: r.crc6f_enddate || ".",
      description: r.crc6f_projectdescription || "",
      manager: r.crc6f_manager || "",
    }));
    // persist to localStorage so details page can read it
    const lsItems = projectsCache.map((p) => ({
      id: p.id,
      name: p.name,
      code: p.code,
      client: p.client,
      contributors: p.contributors,
      status: p.status,
      start: p.start,
      end: p.end,
      description: p.description,
      manager: p.manager,
      estimatedCost: 0,
      currency: "INR",
      billing: "Fixed",
      contributorsList: [],
      boards: [],
      tasks: [],
    }));
    localStorage.setItem(LS_KEY, JSON.stringify(lsItems));
  } catch (e) {
    console.error("Failed to fetch projects", e);
    projectsCache = [];
  }
}

function projectFormHTML(p = {}) {
  return `
  <div class="modal-form modern-form project-form">
    <div class="form-section">
      <div class="form-section-header">
        <div>
          <p class="form-eyebrow">Project</p>
          <h3>Project Details</h3>
        </div>
      </div>
      <div class="form-grid two-col">
        <div class="form-field">
          <label class="form-label" for="pj-name">Project Name</label>
          <input class="input-control" id="pj-name" type="text" value="${p.name || ""
    }">
        </div>

        <div class="form-field">
          <label class="form-label" for="pj-client">Client</label>
          <select class="input-control" id="pj-client">
            <option value="">Select Client</option>
          </select>
        </div>

        <div class="form-field">
          <label class="form-label" for="pj-manager">Manager</label>
          <select class="input-control" id="pj-manager">
            <option value="">Select Manager</option>
          </select>
        </div>

        <div class="form-field">
          <label class="form-label" for="pj-cost">Estimation Cost</label>
          <input class="input-control" id="pj-cost" type="number" value="${p.estimatedCost || ""
    }">
        </div>

        <div class="form-field">
          <label class="form-label" for="pj-status">Project Status</label>
          <select class="input-control" id="pj-status">
            <option ${p.status === "Active" ? "selected" : ""}>Active</option>
            <option ${p.status === "Inactive" ? "selected" : ""}>Inactive</option>
            <option ${p.status === "Completed" ? "selected" : ""}>Completed</option>
            <option ${p.status === "Pending" ? "selected" : ""}>Pending</option>
          </select>
        </div>

        <div class="form-field">
          <label class="form-label" for="pj-start">Start date</label>
          <input class="input-control" id="pj-start" type="date" onkeydown="return false;" value="${toISO(
      p.start
    )}">
        </div>

        <div class="form-field">
          <label class="form-label" for="pj-end">End date</label>
          <input class="input-control" id="pj-end" type="date" onkeydown="return false;" value="${toISO(
      p.end
    )}">
        </div>

        <div class="form-field" style="grid-column:1 / -1;">
          <label class="form-label" for="pj-desc">Project Description</label>
          <textarea class="input-control" id="pj-desc" rows="3">${p.description || ""
    }</textarea>
        </div>
      </div>
    </div>
  </div>`;
}

export function showProjectModal(p) {
  const isEdit = !!(p && p._recordId);

  renderModal(
    isEdit ? "Edit Project" : "Add Project",
    projectFormHTML(p || {}),
    "pj-save"
  );

  // ✅ Enforce Start-End date validation inside Add/Edit modal
  const startInput = document.getElementById("pj-start");
  const endInput = document.getElementById("pj-end");
  if (startInput && endInput) {
    startInput.addEventListener("change", () => {
      endInput.min = startInput.value;
      if (endInput.value && endInput.value < startInput.value) {
        endInput.value = "";
        alert("⚠️ End date cannot be before Start date.");
      }
    });
  }

  // ✅ Populate Client Dropdown
  (async () => {
    const clientSelect = document.getElementById("pj-client");
    if (!clientSelect) return;

    clientSelect.innerHTML = `<option value="">Loading...</option>`;

    const res = await fetch(`${API_ROOT}/api/clients/names`);
    const data = await res.json();

    if (!res.ok || !data.clients) {
      clientSelect.innerHTML = `<option value="">Failed to load clients</option>`;
      return;
    }

    clientSelect.innerHTML = `<option value="">Select Client</option>`;
    data.clients.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.crc6f_clientname;
      opt.textContent = c.crc6f_clientname;

      // ✅ Pre-select existing client when editing
      if (
        p?.client &&
        p.client.trim().toLowerCase() ===
        c.crc6f_clientname.trim().toLowerCase()
      ) {
        opt.selected = true;
      }

      clientSelect.appendChild(opt);
    });

    // If not editing but you want a default (optional)
    if (!p?.client) clientSelect.value = "";
  })();

  // ✅ Populate Manager Dropdown
  (async () => {
    const mgrSelect = document.getElementById("pj-manager");
    if (!mgrSelect) return;

    mgrSelect.innerHTML = `<option value="">Loading...</option>`;

    const res = await fetch(`${API_ROOT}/api/managers/all`);
    const data = await res.json();

    if (!res.ok || !data.managers) {
      mgrSelect.innerHTML = `<option value="">Failed to load managers</option>`;
      return;
    }

    mgrSelect.innerHTML = `<option value="">Select Manager</option>`;
    data.managers.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.name;
      opt.textContent = m.name;

      // ✅ Pre-select existing manager when editing
      if (
        p?.manager &&
        p.manager.trim().toLowerCase() === m.name.trim().toLowerCase()
      ) {
        opt.selected = true;
      }

      mgrSelect.appendChild(opt);
    });

    // Optional: handle empty manager
    if (!p?.manager) mgrSelect.value = "";
  })();

  // ✅ Save Button Handler
  const form = document.getElementById("modal-form");
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      await handleSaveProject(p);
    };
  }

  // ✅ Close modal
  document
    .querySelectorAll(".modal-close-btn")
    .forEach((b) => (b.onclick = closeModal));
}

async function handleSaveProject(p) {
  const payload = {
    crc6f_projectid: (document.getElementById("pj-id")?.value || "").trim(),
    crc6f_projectname: (document.getElementById("pj-name")?.value || "").trim(),
    crc6f_client: (document.getElementById("pj-client")?.value || "").trim(),
    crc6f_manager: (document.getElementById("pj-manager")?.value || "").trim(),
    crc6f_noofcontributors: String(
      parseInt(document.getElementById("pj-contrib")?.value || "0", 10) || 0
    ),
    crc6f_estimationcost: String(
      parseFloat(document.getElementById("pj-cost")?.value || "0") || 0
    ),
    crc6f_projectstatus: (
      document.getElementById("pj-status")?.value || ""
    ).trim(),
    crc6f_startdate: (document.getElementById("pj-start")?.value || "").trim(),
    crc6f_enddate: (document.getElementById("pj-end")?.value || "").trim(),
    crc6f_projectdescription: (
      document.getElementById("pj-desc")?.value || ""
    ).trim(),
  };
  const start = document.getElementById("pj-start")?.value;
  const end = document.getElementById("pj-end")?.value;

  if (start && end && end < start) {
    alert("❌ End date cannot be before start date.");
    return;
  }

  if (!p || !p._recordId) {
    // create
    const res = await fetch(PROJECTS_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const out = await res.json();
    if (!res.ok) return alert(out.error || "Failed to create");
  } else {
    // update
    const res = await fetch(`${PROJECTS_API}/${encodeURIComponent(p._recordId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const out = await res.json();
    if (!res.ok) return alert(out.error || "Failed to update");
  }
  closeModal();
  await fetchProjects();
  renderList();
}

async function handleDeleteProject(recordId) {
  if (!confirm("Delete this project?")) return;
  
  console.log("Deleting project with recordId:", recordId);
  console.log("Delete URL:", `${PROJECTS_API}/${encodeURIComponent(recordId)}`);
  
  try {
    const res = await fetch(`${PROJECTS_API}/${encodeURIComponent(recordId)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });
    
    console.log("Delete response status:", res.status);
    const out = await res.json();
    console.log("Delete response:", out);
    
    if (!res.ok) {
      console.error("Delete failed:", out);
      return alert(out.error || "Failed to delete");
    }
    
    alert("Project deleted successfully!");
    await fetchProjects();
    renderList();
  } catch (error) {
    console.error("Delete error:", error);
    alert("Delete failed: " + error.message);
  }
}


// ---------- Details Page (Tabs) ----------

const TAB_ICONS = {
  details: "fa-clipboard-list",
  contributors: "fa-users",
  boards: "fa-table-columns",
  crm: "fa-layer-group",
};

const renderProjectDetails = (id, tab) => {
  const all = load();
  const p = all.find((x) => x.id === id);
  if (!p) {
    window.location.hash = "#/time-projects";
    return;
  }
  const { canManage } = getProjectAccess();

  const tabs = ["details", "contributors", "boards", "crm"];

  const tabsHtml = `
  <div class="tabs">
    ${tabs
      .filter((t) => !(t === "crm" && tab !== "crm")) // 👈 hide CRM unless active
      .map(
        (t) =>
          `<button class="tab ${t === tab ? "active" : ""}" data-tab="${t}">
             <i class="fa-solid ${TAB_ICONS[t]}"></i> ${labelFor(t)}
           </button>`
      )
      .join("")}
  </div>`;

  const subHeader = `
  <div class="subheader" 
       style="background: var(--primary-color); color: #fff; padding: 14px 20px; 
              border-radius: 10px; display: flex; align-items: center; 
              justify-content: space-between; box-shadow: 0 1px 0 rgba(0,0,0,.05) inset;">
    <div class="crumb" style="font-weight: 600; font-size: 16px;">
      ${p.name} <span style="opacity:.85; font-weight:500;">› ${labelFor(
    tab
  )}</span>
    </div>

    <div class="crm-toolbar" style="display: flex; gap: 10px; align-items: center;">
      <button id="projects-back" class="btn btn-light" style="background:white; color:var(--primary-color); font-weight:600; border-radius:8px;">
        <i class="fa-solid fa-arrow-left"></i> BACK
      </button>
      ${tab === "details" && canManage
      ? '<button id="pd-edit" class="btn btn-light" style="background:white; color:var(--primary-color); font-weight:600; border-radius:8px;">EDIT</button>'
      : ""
    }
      ${tab === "boards" && canManage
      ? '<button id="board-add" class="btn btn-light" style="background:white; color:var(--primary-color); font-weight:600; border-radius:8px;">ADD NEW</button>'
      : ""
    }
      ${tab === "crm" && canManage
      ? `
        <div class="dropdown">
          <button id="crm-add-dd" class="btn btn-light" style="background:white; color:var(--primary-color); font-weight:600; border-radius:8px;">
            ADD NEW <i class="fa-solid fa-caret-down"></i>
          </button>
          <div id="crm-add-menu" class="dropdown-menu" style="display:none;">
            <button class="dropdown-item" data-type="Task">Task</button>
            <button class="dropdown-item" data-type="Bug">Bug</button>
          </div>
        </div>
        <button class="btn btn-secondary" title="Board"><i class="fa-solid fa-table-columns"></i></button>
        <button class="btn btn-secondary" title="List"><i class="fa-solid fa-list"></i></button>
        <button class="btn btn-secondary" title="Filter"><i class="fa-solid fa-filter"></i></button>
        `
      : ""
    }
    </div>
  </div>`;

  const styles = `
    <style>
      .tabs{ display:flex; gap:8px; padding:12px 12px 0; border-bottom:1px solid var(--border-color); }
      .tab{ background:transparent; border:none; padding:10px 12px; border-bottom:3px solid transparent; cursor:pointer; color:var(--text-secondary); font-weight:600; }
      .tab.active{ border-bottom-color: var(--primary-color); color: var(--primary-color); }
      .tab-body{ padding:16px; }
      .form-grid{ display:grid; grid-template-columns:1fr 1fr; gap:14px; }
      @media (max-width: 900px){ .form-grid{ grid-template-columns:1fr; } }
      .table td,.table th{ padding:14px 16px; }
      .kan-wrap{ display:flex; gap:16px; align-items:flex-start; overflow:auto; padding:8px 4px; }
      .kan-list{ min-width:260px; padding:12px; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,.06); border:1px solid #e2e8f0; }
      .kan-head{ display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; color:#0f172a; font-weight:700; }
      .kan-head .badge{ background:#e5edff; color:#1d4ed8; }
      .kan-card{ background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:10px 12px; margin-bottom:10px; box-shadow:0 2px 4px rgba(0,0,0,.08); transition:transform 120ms ease, box-shadow 120ms ease; }
      .kan-card:hover{ transform:translateY(-2px); box-shadow:0 4px 10px rgba(0,0,0,.08); }
      .badge{ padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; display:inline-block; }
      .badge.low{ background:#e8f0fe; color:#1a73e8; }
      .badge.medium{ background:#fff4e5; color:#c07400; }
      .badge.high{ background:#fde7e9; color:#c62828; }
      .priority{ padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; text-transform:capitalize; }
      .priority.low{ background:#e8f0fe; color:#1a73e8; }
      .priority.medium{ background:#fff4e5; color:#c07400; }
      .priority.high{ background:#fde7e9; color:#c62828; }
      .card-meta{ display:flex; justify-content:space-between; gap:8px; font-size:12px; color:#475467; margin-top:6px; }
      .card-meta .label{ color:#6b7280; font-weight:600; }
      .avatar{ width:28px; height:28px; border-radius:50%; background:var(--primary-color); color:#fff; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; }
      .due-pill{ padding:4px 8px; border-radius:999px; background:#f3f4f6; font-size:11px; }
      .due-pill.overdue{ background:#fdecea; color:#d93025; }
    </style>`;

  const smallHeader = `
    <div style="padding:8px 0 6px 0; font-weight:700; color:#0f172a;">
      ${p.name} <span style="opacity:.7; font-weight:600;">› ${labelFor(
    tab
  )}</span>
    </div>
  `;

  const body = `
  ${subHeader}
  <div class="card">
    ${tabsHtml}
    <div class="tab-body">
      ${tab === "details" ? detailsTab(p) : ""}
      ${tab === "contributors" ? contributorsTab(p) : ""}
      ${tab === "boards" ? '<div id="project-tab-content"></div>' : ""}
      ${tab === "crm" ? '<div id="crm-container">Loading CRM...</div>' : ""}
    </div>
  </div>
`;

  document.getElementById("app-content").innerHTML = getPageContentHTML(
    "",
    styles + body,
    ""
  );

  const backBtn = document.getElementById("projects-back");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      window.location.hash = "#/time-projects";
    });
  }

  // Tab switching
  document.querySelectorAll(".tab").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      const t = e.currentTarget.getAttribute("data-tab");
      window.location.hash = `#/time-projects?id=${encodeURIComponent(
        id
      )}&tab=${t}`;
    })
  );

  // Actions
  if (tab === "details") {
    const editBtn = document.getElementById("pd-edit");
    if (!canManage) {
      if (editBtn) editBtn.style.display = "none";
    }
    if (canManage && editBtn) {
      editBtn.addEventListener("click", async function handleEditClick() {
        const isEditing = editBtn.textContent === "EDIT";

        //       if (isEditing) {
        //         // Enable all fields except Project Code
        //         const inputs = document.querySelectorAll(
        //           "#project-details-form input:not(#pd-code), #project-details-form select, #project-details-form textarea"
        //         );

        //         inputs.forEach((el) => {
        //           el.removeAttribute("readonly");
        //           el.removeAttribute("disabled");
        //           el.classList.remove("readonly-input");
        //         });

        //         // Keep Project Code disabled
        //         const codeField = document.getElementById("pd-code");
        //         if (codeField) codeField.setAttribute("disabled", true);

        //         // ✅ ADD THIS: Enforce Start-End Date Validation
        //         const startInput = document.getElementById("pd-start");
        //         const endInput = document.getElementById("pd-end");

        //         if (startInput && endInput) {
        //           // Set min date dynamically
        //           startInput.addEventListener("change", () => {
        //             endInput.min = startInput.value;
        //             if (endInput.value && endInput.value < startInput.value) {
        //               endInput.value = "";
        //               alert("⚠️ End date cannot be before Start date.");
        //             }
        //           });
        //         }

        //         // Switch to SAVE mode
        //         editBtn.textContent = "SAVE";
        //         // ✅ Populate client dropdown dynamically
        //         // ✅ Convert Manager field to dropdown with preselected value
        //         (async () => {
        //           const mgrSelect = document.getElementById("pd-manager");
        //           mgrSelect.innerHTML = `<option value="">Loading...</option>`;

        //           const res = await fetch("http://localhost:5000/api/managers/all");
        //           const data = await res.json();

        //           if (!res.ok || !data.managers) {
        //             mgrSelect.innerHTML = `<option value="">Failed to load managers</option>`;
        //             return;
        //           }

        //           mgrSelect.innerHTML = `<option value="">Select Manager</option>`;
        //           data.managers.forEach((m) => {
        //             const opt = document.createElement("option");
        //             opt.value = m.name;
        //             opt.textContent = m.name;

        //             // ✅ Pre-select existing manager when editing
        //             if (
        //               p.manager &&
        //               p.manager.trim().toLowerCase() === m.name.trim().toLowerCase()
        //             ) {
        //               opt.selected = true;
        //             }

        //             mgrSelect.appendChild(opt);
        //           });
        //         })();

        //         // ✅ Convert Client field to dropdown with preselected value
        //         (async () => {
        //           const clientSelect = document.getElementById("pd-client");
        //           clientSelect.innerHTML = `<option value="">Loading...</option>`;

        //           const res = await fetch(`${API_BASE}/api/clients/names`);
        //           const data = await res.json();

        //           if (!res.ok || !data.clients) {
        //             clientSelect.innerHTML = `<option value="">Failed to load clients</option>`;
        //             return;
        //           }

        //           clientSelect.innerHTML = `<option value="">Select Client</option>`;
        //           data.clients.forEach((c) => {
        //             const opt = document.createElement("option");
        //             opt.value = c.crc6f_clientname;
        //             opt.textContent = c.crc6f_clientname;

        //             // ✅ Pre-select existing client when editing
        //             if (
        //               p.client &&
        //               p.client.trim().toLowerCase() ===
        //                 c.crc6f_clientname.trim().toLowerCase()
        //             ) {
        //               opt.selected = true;
        //             }

        //             clientSelect.appendChild(opt);
        //           });
        //         })();
        //       } else {
        //         // Save mode → update backend
        //         await saveDetails(id);
        //         alert("✅ Project details updated successfully!");

        //         // Lock all fields again after saving
        //         const inputs = document.querySelectorAll(
        //           "#project-details-form input, #project-details-form select, #project-details-form textarea"
        //         );
        //         inputs.forEach((el) => {
        //           el.setAttribute("readonly", true);
        //           el.classList.add("readonly-input");
        //         });

        //         // Ensure Project Code is still disabled
        //         const codeField = document.getElementById("pd-code");
        //         if (codeField) codeField.setAttribute("disabled", true);
        //         // ✅ Disable client dropdown again
        //         const clientSelect = document.getElementById("pd-client");
        //         if (clientSelect) {
        //           const selectedClient =
        //             clientSelect.value || clientSelect.getAttribute("data-current");
        //           clientSelect.innerHTML = `<option value="${selectedClient}">${
        //             selectedClient || "Select Client"
        //           }</option>`;
        //           clientSelect.setAttribute("disabled", true);
        //         }

        //         // Change button text back to EDIT
        //         editBtn.textContent = "EDIT";
        //       }
        //     });
        //   }
        // }

        // if (tab==='contributors') {
        //   const add = document.getElementById('ctr-add');
        //   if (add) add.addEventListener('click', ()=> addContributor(id));
        //   document.querySelectorAll('.ctr-del').forEach(b=>b.addEventListener('click',e=>{ const i = +e.currentTarget.dataset.i; removeContributor(id,i); renderProjectDetails(id,'contributors'); }));
        // }
        if (isEditing) {
          // Enable all fields except Project Code
          const inputs = document.querySelectorAll(
            "#project-details-form input:not(#pd-code), #project-details-form select, #project-details-form textarea"
          );

          inputs.forEach((el) => {
            el.removeAttribute("readonly");
            el.removeAttribute("disabled");
            el.classList.remove("readonly-input");
          });

          // Keep Project Code disabled
          const codeField = document.getElementById("pd-code");
          if (codeField) codeField.setAttribute("disabled", true);

          // ✅ ADD THIS: Enforce Start-End Date Validation
          const startInput = document.getElementById("pd-start");
          const endInput = document.getElementById("pd-end");

          if (startInput && endInput) {
            // Set min date dynamically
            startInput.addEventListener("change", () => {
              endInput.min = startInput.value;
              if (endInput.value && endInput.value < startInput.value) {
                endInput.value = "";
                alert("⚠️ End date cannot be before Start date.");
              }
            });
          }

          // Switch to SAVE mode
          editBtn.textContent = "SAVE";
          // ✅ Populate client dropdown dynamically
          // ✅ Convert Manager field to dropdown with preselected value
          (async () => {
            const mgrSelect = document.getElementById("pd-manager");
            mgrSelect.innerHTML = `<option value="">Loading...</option>`;

            const res = await fetch(`${API_ROOT}/api/managers/all`);
            const data = await res.json();

            if (!res.ok || !data.managers) {
              mgrSelect.innerHTML = `<option value="">Failed to load managers</option>`;
              return;
            }

            mgrSelect.innerHTML = `<option value="">Select Manager</option>`;
            data.managers.forEach((m) => {
              const opt = document.createElement("option");
              opt.value = m.name;
              opt.textContent = m.name;
              if (
                p.manager &&
                p.manager.trim().toLowerCase() === m.name.trim().toLowerCase()
              ) {
                opt.selected = true;
              }
              mgrSelect.appendChild(opt);
            });
          })();

          // ✅ Convert Client field to dropdown with preselected value
          (async () => {
            const clientSelect = document.getElementById("pd-client");
            clientSelect.innerHTML = `<option value="">Loading...</option>`;

            const res = await fetch(`${API_ROOT}/api/clients/names`);
            const data = await res.json();

            if (!res.ok || !data.clients) {
              clientSelect.innerHTML = `<option value="">Failed to load clients</option>`;
              return;
            }

            clientSelect.innerHTML = `<option value="">Select Client</option>`;
            data.clients.forEach((c) => {
              const opt = document.createElement("option");
              opt.value = c.crc6f_clientname;
              opt.textContent = c.crc6f_clientname;
              if (
                p.client &&
                p.client.trim().toLowerCase() ===
                c.crc6f_clientname.trim().toLowerCase()
              ) {
                opt.selected = true;
              }
              clientSelect.appendChild(opt);
            });
          })();
        } else {
          // Save mode → update backend
          await saveDetails(id);
          alert("✅ Project details updated successfully!");

          // Lock all fields again after saving
          const inputs = document.querySelectorAll(
            "#project-details-form input, #project-details-form select, #project-details-form textarea"
          );
          inputs.forEach((el) => {
            el.setAttribute("readonly", true);
            el.classList.add("readonly-input");
          });

          // Ensure Project Code is still disabled
          const codeField = document.getElementById("pd-code");
          if (codeField) codeField.setAttribute("disabled", true);
          // ✅ Disable client dropdown again
          const clientSelect = document.getElementById("pd-client");
          if (clientSelect) {
            const selectedClient =
              clientSelect.value || clientSelect.getAttribute("data-current");
            clientSelect.innerHTML = `<option value="${selectedClient}">${selectedClient || "Select Client"
              }</option>`;
            clientSelect.setAttribute("disabled", true);
          }

          // Change button text back to EDIT
          editBtn.textContent = "EDIT";
        }
      });
    }
  }
  if (tab === "contributors") {
    const add = document.getElementById("ctr-add");
    if (add) {
      if (canManage) {
        add.addEventListener("click", () => showContributorModal(id, null));
      } else {
        add.style.display = "none";
      }
    }
    fetchContributors(id);
  }
  // if (tab === "contributors") {
  //   const role = localStorage.getItem("role") || "L1";

  //   if (role === "L1") {
  //     // Hide the ADD button
  //     const addBtn = document.getElementById("ctr-add");
  //     if (addBtn) addBtn.style.display = "none";

  //     // Disable action buttons (edit/delete)
  //     setTimeout(() => {
  //       document.querySelectorAll(".ctr-edit, .ctr-del").forEach((btn) => {
  //         btn.style.display = "none";
  //       });
  //     }, 300);
  //   }
  //   const add = document.getElementById("ctr-add");
  //   if (add)
  //     add.addEventListener("click", () => showContributorModal(id, null));
  //   fetchContributors(id); // refresh list
  // }

  // if (tab==='boards') {
  //   const add = document.getElementById('board-add');
  //   if (add) add.addEventListener('click', ()=> addBoard(id));
  //   document.querySelectorAll('.board-fav').forEach(b=>b.addEventListener('click',e=>{ const i=+e.currentTarget.dataset.i; toggleBoardFav(id,i); renderProjectDetails(id,'boards'); }));
  //   document.querySelectorAll('.board-row').forEach(r=>r.addEventListener('click',()=>{ window.location.hash = `#/time-projects?id=${encodeURIComponent(id)}&tab=crm`; }));
  // }

  //   if (tab === "boards") {
  //     const role = localStorage.getItem("role") || "L1";
  //     if (role === "L1") {
  //       const addBtn = document.getElementById("board-add");
  //       if (addBtn) addBtn.style.display = "none";

  //       setTimeout(() => {
  //         document
  //           .querySelectorAll(".board-edit, .board-delete")
  //           .forEach((btn) => {
  //             btn.style.display = "none";
  //           });
  //       }, 300);
  //     }
  //     renderBoardsTab(id);
  //   }

  //   if (tab === "crm") {
  //     const crmContainer = document.getElementById("crm-container");
  //     crmContainer.innerHTML = `<div class="placeholder-text">Loading CRM...</div>`;
  //     // 🔐 L1 cannot add tasks
  //     const role = localStorage.getItem("role") || "L1";
  //     if (role === "L1") {
  //       document.getElementById("crm-add-dd")?.remove();
  //     }

  //     // ✅ Get the latest board from URL
  //     const urlParams = new URLSearchParams(window.location.hash.split("?")[1]);
  //     const selectedBoard = urlParams.get("board") || "";

  //     // ✅ Load CRM content dynamically
  //     crmTab(p).then((html) => {
  //       crmContainer.innerHTML = html;
  //       enableDragDrop(id);

  //       // reattach dropdown & buttons
  //       const dd = document.getElementById("crm-add-dd");
  //       const menu = document.getElementById("crm-add-menu");
  //       if (dd && menu) {
  //         dd.addEventListener("click", () => {
  //           menu.style.display = menu.style.display === "none" ? "block" : "none";
  //         });
  //         document.addEventListener("click", (ev) => {
  //           if (!dd.contains(ev.target) && !menu.contains(ev.target))
  //             menu.style.display = "none";
  //         });
  //         menu.querySelectorAll(".dropdown-item").forEach((i) =>
  //           i.addEventListener("click", (e) => {
  //             const type = e.currentTarget.dataset.type;
  //             showTaskModal(id, "New", type);
  //             menu.style.display = "none";
  //           })
  //         );
  //       }
  //     });
  //   }
  // };
  if (tab === "boards") {
    renderBoardsTab(id, canManage);
  }

  if (tab === "crm") {
    const crmContainer = document.getElementById("crm-container");
    crmContainer.innerHTML = `<div class="placeholder-text">Loading CRM...</div>`;

    // ✅ Get the latest board from URL
    const urlParams = new URLSearchParams(window.location.hash.split("?")[1]);
    const selectedBoard = urlParams.get("board") || "";

    // ✅ Load CRM content dynamically
    crmTab(p, canManage).then((html) => {
      crmContainer.innerHTML = html;
      enableDragDrop(id);

      // reattach dropdown & buttons
      if (!canManage) {
        document.getElementById("crm-add-dd")?.remove();
        document.getElementById("crm-add-menu")?.remove();
      } else {
        attachCRMEventHandlers(id);
      }
    });
  }
};

const labelFor = (t) => {
  if (t === "details") return "Project Details";
  if (t === "contributors") return "Project Contributors";
  if (t === "boards") return "Boards";
  if (t === "crm") {
    try {
      const hash = window.location.hash || "";
      const qs = hash.split("?")[1] || "";
      const params = new URLSearchParams(qs);
      const boardName = (params.get("boardName") || params.get("board") || "").trim();
      return boardName || "CRM";
    } catch {
      return "CRM";
    }
  }
  return "CRM";
};
async function fetchClientsList() {
  try {
    const res = await fetch(`${API_ROOT}/api/clients/names`);

    const data = await res.json();

    if (!res.ok || !data.clients) {
      console.error("❌ Failed to load clients:", data);
      return [];
    }

    // Return only names (crc6f_clientname)
    return data.clients.map((c) => ({
      id: c.crc6f_hr_clientsid,
      name: c.crc6f_clientname,
    }));
  } catch (err) {
    console.error("🔥 Error fetching clients:", err);
    return [];
  }
}

// ----- Details Tab -----
// ----- Details Tab (replace existing contributorsTab) -----
// ----- Details Tab (FINAL FIXED VERSION) -----
const detailsTab = (p) => {
  let isEditMode = false; // 👈 ADD THIS LINE HERE

  return `
  <style>
    .readonly-input, select[disabled], textarea[readonly] {
      background: #f9f9f9;
      border-color: #ddd;
      color: #555;
      cursor: not-allowed;
    }
  </style>

  <div class="modal-form modern-form project-details-form">
    <div class="form-section">
      <div class="form-section-header">
        <div>
          <p class="form-eyebrow">Project</p>
          <h3>Project details</h3>
        </div>
      </div>
      <div class="form-grid two-col" id="project-details-form">
        <div class="form-field">
          <label class="form-label" for="pd-name">Project name</label>
          <input class="input-control readonly-input" id="pd-name" type="text" value="${p.name || ""
    }" readonly>
        </div>

        <div class="form-field">
          <label class="form-label" for="pd-code">Project code</label>
          <input class="input-control readonly-input" id="pd-code" type="text" value="${p.code || ""
    }" disabled>
        </div>

        <div class="form-field">
          <label class="form-label" for="pd-manager">Manager name</label>
          <select class="input-control readonly-input" id="pd-manager" disabled data-current="${p.manager || ""
    }">
            <option value="">${p.manager || "Select Manager"}</option>
          </select>
        </div>

        <div class="form-field">
          <label class="form-label" for="pd-client">Client name</label>
          <select class="input-control readonly-input" id="pd-client" disabled data-current="${p.client || ""
    }">
            <option value="">${p.client ? p.client : "Select Client"}</option>
          </select>
        </div>

        <div class="form-field" style="grid-column:1 / -1;">
          <label class="form-label" for="pd-desc">Description</label>
          <textarea class="input-control readonly-input" id="pd-desc" rows="3" readonly>${p.description || ""
    }</textarea>
        </div>

        <div class="form-field">
          <label class="form-label" for="pd-est">Estimated cost</label>
          <input class="input-control readonly-input" id="pd-est" type="number" value="${p.estimatedCost || ""
    }" readonly>
        </div>

        <div class="form-field">
          <label class="form-label" for="pd-curr">Currency</label>
          <select class="input-control readonly-input" id="pd-curr" disabled>
            <option ${p.currency === "INR" ? "selected" : ""}>INR</option>
            <option ${p.currency === "USD" ? "selected" : ""}>USD</option>
          </select>
        </div>

        <div class="form-field">
          <label class="form-label" for="pd-start">Start date</label>
          <input class="input-control readonly-input" id="pd-start" type="date" onkeydown="return false;" value="${toISO(
      p.start
    )}" readonly>
        </div>

        <div class="form-field">
          <label class="form-label" for="pd-end">End date</label>
          <input class="input-control readonly-input" id="pd-end" type="date" onkeydown="return false;" value="${toISO(
      p.end
    )}" readonly>
        </div>
      </div>
    </div>
  </div>
`;
};

const toISO = (s) => {
  if (!s || s === ".") return "";
  try {
    const d = new Date(s);
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
  } catch { }
  return "";
};
const saveDetails = async (id) => {
  try {
    const project = projectsCache.find((p) => p.id === id);
    if (!project) {
      alert("⚠️ Project not found!");
      return;
    }

    const payload = {
      crc6f_projectname: document.getElementById("pd-name")?.value.trim() || "",
      crc6f_client: document.getElementById("pd-client")?.value.trim() || "",
      crc6f_manager: document.getElementById("pd-manager")?.value.trim() || "",
      crc6f_projectdescription:
        document.getElementById("pd-desc")?.value.trim() || "",
      crc6f_estimationcost:
        document.getElementById("pd-est")?.value.trim() || "",
      crc6f_projectstatus: project.status || "Active",
      crc6f_startdate: document.getElementById("pd-start")?.value.trim() || "",
      crc6f_enddate: document.getElementById("pd-end")?.value.trim() || "",
    };

    const res = await fetch(
      `${PROJECTS_API}/${encodeURIComponent(project._recordId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    const data = await res.json();

    if (res.ok) {
      console.log("✅ Project updated:", data);
      alert("✅ Project details updated successfully!");
      await fetchProjects();
      renderProjectDetails(id, "details");
    } else {
      console.error("❌ Update failed:", data);
      alert("❌ Failed to update project: " + (data.error || "Unknown error"));
    }
  } catch (err) {
    console.error("🔥 saveDetails error:", err);
    alert("Server or network error while updating project details.");
  }
};

// const saveDetails = (id) => {
//   const list = load(); const i = list.findIndex(x=>x.id===id); if (i<0) return;
//   list[i] = { ...list[i], name: val('pd-name'), manager: val('pd-manager'), client: val('pd-client'), description: val('pd-desc'), estimatedCost: parseFloat(val('pd-est')||'0')||0, currency: val('pd-curr'), billing: val('pd-bill'), start: fromISO(val('pd-start')), end: fromISO(val('pd-end')) };
//   localStorage.setItem(LS_KEY, JSON.stringify(list));
// };
const val = (id) => (document.getElementById(id)?.value || "").trim();
const fromISO = (s) => {
  if (!s) return "";
  try {
    const d = new Date(s);
    return d.toISOString().slice(0, 10);
  } catch {
    return "";
  }
};

// ----- Contributors Tab (replace existing contributorsTab) -----
// ----- Contributors Tab (FINAL FIXED VERSION) -----
const contributorsTab = (p) => {
  return `
    <div class="contributors-section" style="padding:10px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <h4 style="margin:0; font-size:16px; color:#333;">Project Contributors</h4>
        <button id="ctr-add" class="btn btn-primary">ADD CONTRIBUTOR</button>
      </div>
      <div id="contributors-container" class="table-container">
        <div class="placeholder-text">Loading contributors...</div>
      </div>
    </div>
  `;
};

// ---------------------- Contributors backend helpers ----------------------
async function fetchContributors(projectId) {
  try {
    const res = await fetch(`${PROJECTS_API}/${projectId}/contributors`);
    const data = await res.json();

    if (!res.ok || !data.contributors) {
      console.error("Failed to load contributors", data);
      document.getElementById(
        "contributors-container"
      ).innerHTML = `<div class="placeholder-text">Failed to load contributors</div>`;
      return;
    }

    const list = data.contributors || [];
    renderContributorsList(projectId, list);
  } catch (err) {
    console.error("Error fetching contributors", err);
    const c = document.getElementById("contributors-container");
    if (c)
      c.innerHTML = `<div class="placeholder-text">Error loading contributors</div>`;
  }
}

function renderContributorsList(projectId, list) {
  const container = document.getElementById("contributors-container");
  const countEl = document.getElementById("contributors-count");
  if (countEl) countEl.textContent = String(list.length);

  if (!container) return;

  const { canManage } = getProjectAccess();

  if (!list || list.length === 0) {
    container.innerHTML = `<table class="table"><tbody><tr><td colspan="5" class="placeholder-text">No contributors added</td></tr></tbody></table>`;
    return;
  }

  const rows = list
    .map((c) => {
      const actionsCell = canManage
        ? `<td style="text-align:right;">
        <button class="icon-btn ctr-edit" data-record="${encodeURIComponent(
          c.record_id || c.contributor_id || ""
        )}" title="Edit"><i class="fa-solid fa-pen-to-square"></i></button>
        <button class="icon-btn ctr-del" data-record="${encodeURIComponent(
          c.record_id || c.contributor_id || ""
        )}" title="Remove"><i class="fa-solid fa-trash" style="color:#d93025;"></i></button>
      </td>`
        : "";
      return `
    <tr>
      <td>${escapeHtml(c.employee_id || c.employeeId || "")}</td>
      <td>${escapeHtml(c.employee_name || c.employeeName || "")}</td>
     <td>${escapeHtml(c.designation || "N/A")}</td>

     <td>${escapeHtml(c.billing_type || c.billingType || "Billable")}</td>

      ${actionsCell}
    </tr>
  `;
    })
    .join("");

  container.innerHTML = `
    <table class="table">
  <thead>
    <tr>
      <th>Employee ID</th>
      <th>Employee Name</th>
      <th>Designation</th>
      <th>Billing</th>
      ${canManage ? '<th style="text-align:right;">Actions</th>' : ""}
    </tr>
  </thead>

    <tbody>${rows}</tbody></table>
  `;

  if (!canManage) return;

  document.querySelectorAll(".ctr-edit").forEach((b) => {
    b.addEventListener("click", (e) => {
      const record = decodeURIComponent(
        e.currentTarget.getAttribute("data-record") || ""
      );

      const rec = list.find(
        (x) =>
          x.guid === record ||
          x.crc6f_hr_projectcontributorsid === record ||
          x.record_id === record
      );

      if (!rec) return alert("No record found");

      showEditContributorModal(
        projectId,
        rec.guid || rec.crc6f_hr_projectcontributorsid || record,
        rec
      );
    });
  });

  document.querySelectorAll(".ctr-del").forEach((b) => {
    b.addEventListener("click", async (e) => {
      const record = decodeURIComponent(
        e.currentTarget.getAttribute("data-record") || ""
      );

      const rec = list.find(
        (x) =>
          x.guid === record ||
          x.crc6f_hr_projectcontributorsid === record ||
          x.record_id === record
      );
      const guid = rec?.guid || rec?.crc6f_hr_projectcontributorsid || record;

      if (!guid) return alert("❌ GUID missing — cannot delete this record.");
      if (!confirm("🗑️ Delete this contributor?")) return;

      try {
        await deleteContributorFromBackend(guid);
        alert("✅ Contributor deleted successfully!");
        await fetchContributors(projectId);
      } catch (err) {
        console.error("🔥 Delete failed:", err);
        alert("❌ Failed to delete contributor — check backend logs.");
      }
    });
  });
}

function showEditContributorModal(projectId, recordId, contributor) {
  const formHtml = `
    <div class="modal-form modern-form contributor-form">
      <div class="form-section">
        <div class="form-section-header">
          <div>
            <p class="form-eyebrow">Contributor</p>
            <h3>Edit contributor</h3>
          </div>
        </div>
        <div class="form-grid two-col">
          <div class="form-field">
            <label class="form-label" for="ct-empname-edit">Employee Name</label>
            <select class="input-control" id="ct-empname-edit">
              <option value="">-- Select Employee --</option>
            </select>
            <small id="emp-error-edit" class="helper-text" style="margin-top:2px;"></small>
          </div>

          <div class="form-field">
            <label class="form-label" for="ct-empid-edit">Employee ID</label>
            <input class="input-control readonly-input" type="text" id="ct-empid-edit" readonly />
          </div>

          <div class="form-field">
            <label class="form-label" for="ct-billing-edit">Billing Type</label>
            <select class="input-control" id="ct-billing-edit">
              <option value="Billable">Billable</option>
              <option value="Non-billable">Non-billable</option>
            </select>
          </div>

          <div class="form-field">
            <label class="form-label" for="ct-date-edit">Assigned Date</label>
            <input class="input-control" type="date" id="ct-date-edit" />
          </div>
        </div>
      </div>
    </div>
  `;

  renderModal("Edit Contributor", formHtml, "ct-save-edit");

  // ✅ Populate Employee Dropdown
  async function populateEmployeeDropdown() {
    try {
      const res = await fetch(`${API_ROOT}/api/employees/all`);
      const data = await res.json();

      const empSelect = document.getElementById("ct-empname-edit");
      empSelect.innerHTML = '<option value="">-- Select Employee --</option>';

      if (data.success && Array.isArray(data.employees)) {
        data.employees.forEach((emp) => {
          const fullName = `${emp.first_name || ""} ${emp.last_name || ""
            }`.trim();
          const option = document.createElement("option");
          option.value = fullName;
          option.setAttribute("data-id", emp.employee_id);
          option.textContent = `${fullName} (${emp.employee_id || ""})`;
          empSelect.appendChild(option);
        });

        // Preselect existing employee in dropdown
        setTimeout(() => {
          for (let option of empSelect.options) {
            if (
              option.getAttribute("data-id") ===
              (contributor.employee_id || contributor.employeeId)
            ) {
              option.selected = true;
              break;
            }
          }
        }, 300);
      } else {
        console.warn("⚠️ No employees found for dropdown");
      }
    } catch (err) {
      console.error("❌ Error loading employees for edit:", err);
    }
  }

  // ✅ Auto-fill employee ID when changing dropdown
  const empSelect = document.getElementById("ct-empname-edit");
  const empIdInput = document.getElementById("ct-empid-edit");
  const empError = document.getElementById("emp-error-edit");

  empSelect.addEventListener("change", () => {
    const selectedOption = empSelect.options[empSelect.selectedIndex];
    const empId = selectedOption.getAttribute("data-id");

    if (empId) {
      empIdInput.value = empId;
      empError.textContent = "✅ Valid employee selected";
      empError.style.color = "#188038";
    } else {
      empIdInput.value = "";
      empError.textContent = "⚠️ Please select an employee";
      empError.style.color = "#d93025";
    }
  });

  // ✅ Prefill billing & date
  document.getElementById("ct-empid-edit").value =
    contributor.employee_id || contributor.employeeId || "";
  document.getElementById("ct-billing-edit").value =
    contributor.billing_type || contributor.billingType || "Billable";
  document.getElementById("ct-date-edit").value =
    contributor.assigned_date || contributor.assignedDate || "";

  // ✅ Load employee list
  populateEmployeeDropdown();

  // ✅ Save Button Handler
  const saveBtn = document.getElementById("ct-save-edit");
  saveBtn.onclick = async () => {
    const payload = {
      employeeId: document.getElementById("ct-empid-edit").value.trim(),
      employeeName: document.getElementById("ct-empname-edit").value.trim(),
      billingType: document.getElementById("ct-billing-edit").value,
      assignedDate: document.getElementById("ct-date-edit").value,
    };

    if (!payload.employeeId || !payload.employeeName) {
      alert("⚠️ Please select a valid employee!");
      return;
    }

    console.log("✏️ Updating contributor:", payload);

    try {
      const res = await fetch(
        `${API_ROOT}/api/contributors/${encodeURIComponent(
          recordId
        )}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        alert("✅ Contributor updated successfully!");
        closeModal();
        fetchContributors(projectId);
      } else {
        console.error("❌ Update failed:", data);
        alert("❌ Update failed: " + (data.error || "Unknown error"));
      }
    } catch (err) {
      console.error("🔥 Error updating contributor:", err);
      alert("Server or network error during update.");
    }
  };
}
function showContributorModal(projectId, contributor = null) {
  const isEdit = !!contributor;

  const formHtml = `
    <div class="modal-form modern-form contributor-form">
      <div class="form-section">
        <div class="form-section-header">
          <div>
            <p class="form-eyebrow">Contributor</p>
            <h3>${isEdit ? "Edit contributor" : "Add contributor"}</h3>
          </div>
        </div>
        <div class="form-grid two-col">
          <div class="form-field">
            <label class="form-label" for="ct-empname">Employee Name</label>
            <select class="input-control" id="ct-empname">
              <option value="">-- Select Employee --</option>
            </select>
            <small id="emp-error" class="helper-text" style="margin-top:2px;"></small>
          </div>

          <div class="form-field">
            <label class="form-label" for="ct-empid">Employee ID</label>
            <input class="input-control readonly-input" type="text" id="ct-empid" readonly />
          </div>

          <div class="form-field">
            <label class="form-label" for="ct-billing">Billing Type</label>
            <select class="input-control" id="ct-billing">
              <option value="Billable">Billable</option>
              <option value="Non-billable">Non-billable</option>
            </select>
          </div>

          <div class="form-field">
            <label class="form-label" for="ct-date">Assigned Date</label>
            <input class="input-control" type="date" id="ct-date" />
          </div>
        </div>
      </div>
    </div>
  `;

  renderModal(
    isEdit ? "Edit Contributor" : "Add Contributor",
    formHtml,
    "ct-save"
  );

  // ✅ Populate Employee Dropdown from Backend (/api/employees/all)
  async function populateEmployeeDropdown() {
    try {
      const res = await fetch(`${API_ROOT}/api/employees/all`);
      const data = await res.json();

      const empSelect = document.getElementById("ct-empname");
      empSelect.innerHTML = '<option value="">-- Select Employee --</option>';

      if (data.success && Array.isArray(data.employees)) {
        data.employees.forEach((emp) => {
          const fullName = `${emp.first_name || ""} ${emp.last_name || ""
            }`.trim();
          const label = `${fullName} (${emp.employee_id || ""})`;
          const option = document.createElement("option");
          option.value = fullName;
          option.setAttribute("data-id", emp.employee_id);
          option.textContent = label;
          empSelect.appendChild(option);
        });

        // Preselect existing employee in dropdown
        setTimeout(() => {
          for (let option of empSelect.options) {
            if (
              option.getAttribute("data-id") ===
              (contributor.employee_id || contributor.employeeId)
            ) {
              option.selected = true;
              break;
            }
          }
        }, 300);
      } else {
        console.warn("⚠️ No employees found to populate dropdown");
      }
    } catch (err) {
      console.error("❌ Error fetching employee list:", err);
    }
  }

  // ✅ Auto-fill Employee ID when selecting a name
  const empSelect = document.getElementById("ct-empname");
  const empIdInput = document.getElementById("ct-empid");
  const empError = document.getElementById("emp-error");

  empSelect.addEventListener("change", async () => {
    const selectedOption = empSelect.options[empSelect.selectedIndex];
    const empId = selectedOption.getAttribute("data-id");
    const empName = selectedOption.value;
    const desigInput = document.getElementById("ct-desig");

    if (empId) {
      empIdInput.value = empId;
      empError.textContent = "✅ Valid employee selected";
      empError.style.color = "#188038";
    } else {
      empIdInput.value = "";
      empError.textContent = "⚠️ Please select an employee";
      empError.style.color = "#d93025";
      desigInput.value = "";
    }
  });

  // ✅ Pre-fill fields if Editing an Existing Contributor
  if (isEdit && contributor) {
    document.getElementById("ct-empid").value = contributor.employeeId || "";
    document.getElementById("ct-desig").value =
      contributor.designation || "N/A";

    document.getElementById("ct-billing").value =
      contributor.billingType || "Billable";
    document.getElementById("ct-date").value = contributor.assignedDate || "";

    // Wait for dropdown to load, then set employee name
    setTimeout(() => {
      const empSelect = document.getElementById("ct-empname");
      for (let option of empSelect.options) {
        if (option.getAttribute("data-id") === contributor.employeeId) {
          option.selected = true;
          break;
        }
      }
    }, 600);
  }

  // ✅ Call the dropdown loader (after modal render)
  populateEmployeeDropdown();

  // ✅ Save Button Handler
  const saveBtn = document.getElementById("ct-save");
  if (saveBtn) {
    saveBtn.onclick = async () => {
      const payload = {
        employeeId: document.getElementById("ct-empid").value.trim(),
        employeeName: document.getElementById("ct-empname").value.trim(),
        billingType: document.getElementById("ct-billing").value,
        assignedDate: document.getElementById("ct-date").value,
      };

      if (!payload.employeeId || !payload.employeeName) {
        alert("⚠️ Please select a valid employee!");
        return;
      }

      try {
        const res = await fetch(
          `${API_ROOT}/api/projects/${projectId}/contributors`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }
        );

        const data = await res.json();
        if (res.ok) {
          alert("✅ Contributor saved successfully!");
          closeModal();
          fetchContributors(projectId); // refresh table
        } else {
          alert("❌ Failed: " + (data.error || "Unknown error"));
        }
      } catch (err) {
        console.error("🔥 Error saving contributor:", err);
        alert("Server or network error. Check console/terminal.");
      }
    };
  }

  // ✅ Close modal on cancel buttons
  document.querySelectorAll(".modal-close-btn").forEach((btn) => {
    btn.addEventListener("click", closeModal);
  });
}

async function saveContributorToBackend(projectId, payload, inline = false) {
  // if payload contains record_id => PATCH, else POST
  if (payload.record_id) {
    const rid = payload.record_id;
    const url = `/api/contributors/${encodeURIComponent(rid)}`;
    // build minimal update body: map our friendly keys to backend expectation
    const body = {};
    if ("employeeId" in payload) body.employeeId = payload.employeeId;
    if ("employeeName" in payload) body.employeeName = payload.employeeName;
    if ("billingType" in payload) body.billingType = payload.billingType;
    if ("assignedDate" in payload) body.assignedDate = payload.assignedDate;
    if ("hourlyRate" in payload) body.hourlyRate = payload.hourlyRate;
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error("Update failed: " + txt);
    }
    return true;
  } else {
    // create
    const url = `${CONTRIBUTORS_API_BASE}/${encodeURIComponent(
      projectId
    )}/contributors`;
    // map fields the backend expects (it accepts employeeId, employeeName, billingType, assignedDate)
    const body = {
      employeeId: payload.employeeId,
      employeeName: payload.employeeName,
      billingType: payload.billingType,
      assignedDate: payload.assignedDate,
      hourlyRate: payload.hourlyRate,
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error("Create failed: " + txt);
    }
    return true;
  }
}

async function deleteContributorFromBackend(recordId) {
  const url = `${API_ROOT}/api/contributors/${encodeURIComponent(recordId)}`;
  console.log("🗑 Sending DELETE request to:", url);

  const res = await fetch(url, { method: "DELETE" });

  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ Delete failed:", txt);
    throw new Error("Delete failed: " + txt);
  }

  console.log("✅ Contributor deleted successfully on backend!");
  return true;
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// =====================
// 🔷 RENDER BOARDS TAB
// =====================
function renderBoardsTab(projectId, canManageOverride = null) {
  const canManage =
    typeof canManageOverride === "boolean"
      ? canManageOverride
      : getProjectAccess().canManage;
  const html = `
   

    <div class="table-container">
      <table class="table" id="boards-table">
        <thead>
          <tr>
            <th>Board Name</th>
            <th>No. of Tasks</th>
            <th>No. of Members</th>
            ${canManage ? '<th style="text-align:right;">Actions</th>' : ""}
          </tr>
        </thead>
        <tbody>
          <tr><td colspan="4" class="placeholder-text">Loading...</td></tr>
        </tbody>
      </table>
    </div>
  `;

  const container = document.getElementById("project-tab-content");
  if (container) container.innerHTML = html;

  // Load data + handle events
  fetchBoards(projectId, canManage);

  if (canManage) {
    document
      .getElementById("board-add")
      ?.addEventListener("click", () => showBoardModal(projectId));
  }
}
async function fetchBoards(projectId, canManageOverride = null) {
  const canManage =
    typeof canManageOverride === "boolean"
      ? canManageOverride
      : getProjectAccess().canManage;
  try {
    const res = await fetch(`${API_ROOT}/api/projects/${projectId}/boards`);
    const data = await res.json();

    if (!res.ok || !data.success) {
      console.error("Failed to load boards:", data.error);
      document.querySelector(
        "#boards-table tbody"
      ).innerHTML = `<tr><td colspan="4" class="placeholder-text">Error loading boards</td></tr>`;
      return;
    }

    const boards = data.boards || [];
    renderBoardsTable(boards, projectId, canManage);
  } catch (err) {
    console.error("Error fetching boards:", err);
  }
}
function renderBoardsTable(boards, projectId, canManage) {
  const tbody = document.querySelector("#boards-table tbody");
  if (!tbody) return;

  if (!boards || boards.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="placeholder-text">No boards</td></tr>`;
    return;
  }

  tbody.innerHTML = boards
    .map(
      (b, i) => `
        <tr data-guid="${b.guid}">
          <td class="board-name" style="color:#007bff; cursor:pointer; font-weight:500;">
            ${b.board_name || ""}
            <div style="color:#6b7280;font-size:12px;">${b.board_description || ""
        }</div>
          </td>
          <td>${b.no_of_tasks || 0}</td>
          <td>${b.no_of_members || 0}</td>
          ${canManage
          ? `<td style="text-align:right;">
            <button class="icon-btn board-edit" data-guid="${b.guid}" title="Edit">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button class="icon-btn board-delete" data-guid="${b.guid}" title="Delete">
              <i class="fa-solid fa-trash" style="color:#d9534f;"></i>
            </button>
          </td>`
          : ""
        }
        </tr>`
    )
    .join("");

  // ✅ Attach click event to open CRM tab when clicking a board name
  document.querySelectorAll(".board-name").forEach((cell) => {
    cell.addEventListener("click", (e) => {
      const row = e.currentTarget.closest("tr");
      const boardId = row.getAttribute("data-guid") || ""; // use GUID or ID
      const board = boards.find((b) => b.guid === boardId) || {};
      const boardCode = board.board_id || boardId;
      const boardName = board.board_name || "";

      window.location.hash = `#/time-projects?id=${encodeURIComponent(
        projectId
      )}&tab=crm&board=${encodeURIComponent(
        boardCode
      )}&boardName=${encodeURIComponent(boardName)}`;
    });
  });

  if (canManage) {
    document.querySelectorAll(".board-edit").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation(); // prevent triggering CRM navigation
        const guid = e.currentTarget.dataset.guid;
        const board = boards.find((b) => b.guid === guid);
        showBoardModal(projectId, board);
      })
    );

    document.querySelectorAll(".board-delete").forEach((btn) =>
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const guid = e.currentTarget.dataset.guid;
        if (!confirm("Delete this board?")) return;
        try {
          const res = await fetch(
            `${API_ROOT}/api/boards/${guid}`,
            { method: "DELETE" }
          );
          const data = await res.json();

          if (res.ok && data.success) {
            alert("✅ Board deleted");
            fetchBoards(projectId, canManage);
          } else {
            alert("❌ " + (data.error || "Delete failed"));
          }
        } catch (err) {
          console.error("Error deleting board:", err);
        }
      })
    );
  }
  //   });
  // }
}

function showBoardModal(projectId, board = null) {
  const isEdit = !!board;

  const formHtml = `
    <div class="modal-form modern-form board-form">
      <div class="form-section">
        <div class="form-section-header">
          <div>
            <p class="form-eyebrow">Board</p>
            <h3>${isEdit ? "Edit board" : "Add board"}</h3>
          </div>
        </div>
        <div class="form-grid two-col">
          <div class="form-field" style="grid-column:1 / -1;">
            <label class="form-label" for="bd-name">Board Name</label>
            <input class="input-control" type="text" id="bd-name" placeholder="Enter board name" />
          </div>

          <div class="form-field" style="grid-column:1 / -1;">
            <label class="form-label" for="bd-desc">Board Description</label>
            <textarea class="input-control" id="bd-desc" rows="3"></textarea>
          </div>

          <div class="form-field">
            <label class="form-label" for="bd-tasks">No. of Tasks</label>
            <input class="input-control" type="number" id="bd-tasks" value="0" />
          </div>

          <div class="form-field">
            <label class="form-label" for="bd-members">No. of Members</label>
            <input class="input-control" type="number" id="bd-members" value="0" />
          </div>
        </div>
      </div>
    </div>
  `;

  renderModal(isEdit ? "Edit Board" : "Add Board", formHtml, "bd-save");

  // Prefill if editing
  if (isEdit) {
    document.getElementById("bd-name").value = board.board_name || "";
    document.getElementById("bd-desc").value = board.board_description || "";
    document.getElementById("bd-tasks").value = board.no_of_tasks || 0;
    document.getElementById("bd-members").value = board.no_of_members || 0;
  }

  // Save logic
  document.getElementById("bd-save").onclick = async () => {
    const payload = {
      board_name: document.getElementById("bd-name").value.trim(),
      board_description: document.getElementById("bd-desc").value.trim(),
      no_of_tasks: parseInt(
        document.getElementById("bd-tasks").value || "0",
        10
      ),
      no_of_members: parseInt(
        document.getElementById("bd-members").value || "0",
        10
      ),
    };

    if (!payload.board_name) {
      alert("⚠️ Please enter a board name");
      return;
    }

    try {
      let url, method;

      if (isEdit) {
        url = `${API_ROOT}/api/boards/${board.guid}`;
        method = "PATCH";
      } else {
        url = `${API_ROOT}/api/projects/${projectId}/boards`;
        method = "POST";
      }

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        alert(isEdit ? "✅ Board updated!" : "✅ Board added!");
        closeModal();
        fetchBoards(projectId);
      } else {
        alert("❌ " + (data.error || "Failed to save board"));
      }
    } catch (err) {
      console.error("Error saving board:", err);
      alert("⚠️ Server error. Check console.");
    }
  };
}
async function deleteBoard(guid, projectId) {
  if (!confirm("🗑️ Are you sure you want to delete this board?")) return;

  try {
    const res = await fetch(`${API_ROOT}/api/boards/${guid}`, {
      method: "DELETE",
    });
    const data = await res.json();

    if (res.ok && data.success) {
      alert("✅ Board deleted");
      fetchBoards(projectId);
    } else {
      alert("❌ " + (data.error || "Delete failed"));
    }
  } catch (err) {
    console.error("Error deleting board:", err);
    alert("⚠️ Server or network issue");
  }
}

// ---------- CRM: dynamic columns (replace the old CRM_COLS + crmTab block) ----------
// -----------------------------------------------
// DEFAULT COLUMNS (never disappear)
// -----------------------------------------------
const DEFAULT_COLS = ["New", "In Progress", "Hold", "Completed"];
// make columns available globally for task details/status selects
if (typeof window !== "undefined") {
  window.GLOBAL_CRM_COLS = DEFAULT_COLS;
}

function getDefaultColor(name) {
  switch (name.trim().toLowerCase()) {
    case "new":
      return "#d9d9d9"; // soft grey
    case "in progress":
      return "#fff4b8"; // pastel yellow
    case "hold":
      return "#fcd4d4"; // pastel pink
    case "completed":
      return "#d5f6de"; // pastel green
    default:
      return "#f4f4f4"; // very light grey
  }
}

async function fetchProjectTasks(projectId) {
  try {
    const res = await fetch(`${API_BASE}/api/projects/${projectId}/tasks`);
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || "Failed to load tasks");
    }
    return data.tasks || [];
  } catch (err) {
    console.error("fetchProjectTasks error:", err);
    return { error: err.message || "Failed to load tasks" };
  }
}

// -----------------------------------------------
// CRM TAB (Kanban)
// -----------------------------------------------
const crmTab = async (project) => {
  const boardParam =
    new URLSearchParams(window.location.hash.split("?")[1] || "").get(
      "board"
    ) || "General";

  const tasksResult = await fetchProjectTasks(project.id);
  if (tasksResult.error) {
    return `<div class="placeholder-text">Failed to load tasks: ${tasksResult.error}</div>`;
  }
  const tasks = Array.isArray(tasksResult) ? tasksResult : [];

  // Get columns from localStorage or use defaults
  const storageKey = `crm_cols_${project.id}`;
  let cols = JSON.parse(localStorage.getItem(storageKey) || "[]");
  
  // If no custom columns exist, use defaults
  if (cols.length === 0) {
    cols = [...DEFAULT_COLS];
    // Save defaults to localStorage for consistency
    localStorage.setItem(storageKey, JSON.stringify(cols));
  }
  
  // Update global columns reference
  if (typeof window !== "undefined") {
    window.GLOBAL_CRM_COLS = cols;
  }
  const grouped = cols.map((col) => ({
    name: col,
    items: tasks.filter(
      (t) =>
        (t.task_status || "").toLowerCase() === col.toLowerCase() &&
        (!t.board_name || t.board_name === boardParam)
    ),
  }));

  const boardName =
    new URLSearchParams(window.location.hash.split("?")[1] || "").get(
      "boardName"
    ) || boardParam;

  const listsHtml = grouped
    .map((col) => {
      const bg = getDefaultColor(col.name);
      const itemsHtml = col.items.length
        ? col.items.map((t, idx) => taskCardHtml(t, idx)).join("")
        : `<div class="placeholder-text">No tasks</div>`;

      return `
      <div class="kan-list" data-col="${col.name}" style="background:${bg}; border-color:${bg};">
        <div class="kan-head">
          <strong>${col.name}</strong>
          <span class="badge">${col.items.length}</span>
        </div>
        ${itemsHtml}
      </div>
    `;
    })
    .join("");

  // Add Plus button for creating new column
  const addColumnButton = `
    <div class="kan-list add-column-btn" onclick="showAddColumnModal('${project.id}', '${boardParam}')" style="background:transparent; border:2px dashed #cbd5e1; min-height:120px; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:all 0.3s ease;">
      <div style="text-align:center; color:#64748b;">
        <i class="fa-solid fa-plus" style="font-size:24px; margin-bottom:8px; display:block;"></i>
        <span style="font-size:14px; font-weight:500;">Add Column</span>
      </div>
    </div>
  `;

  return `
    <div class="board-header" style="margin-bottom:10px; font-weight:700; color:#0f172a;">
      Board: ${boardName}
    </div>
    <div class="kan-wrap">
      ${listsHtml}
      ${addColumnButton}
    </div>
    <style>
      .add-column-btn:hover {
        background: #f8fafc !important;
        border-color: #94a3b8 !important;
        transform: scale(1.02);
      }
      .add-column-btn:hover i,
      .add-column-btn:hover span {
        color: #475569 !important;
      }
    </style>
  `;
};

// ==========================
// Add Column Modal
// ==========================
function showAddColumnModal(projectId, boardParam) {
  const formHTML = `
    <div class="form-group" style="display:flex; flex-direction:column; gap:10px;">
      <div style="display:flex; flex-direction:column; gap:6px;">
        <label for="col-name" style="font-weight:600;">Column Name</label>
        <input type="text" id="col-name" placeholder="Enter column name (e.g., 'In Review')" style="padding:10px; border-radius:10px; border:1px solid var(--border-color);" maxlength="50" />
        <small style="color:#64748b;">Choose a name for your new status column</small>
      </div>
    </div>
  `;
  
  renderModal("Add New Column", formHTML, "col-add-submit", "normal", "Add Column");
  
  const form = document.getElementById("modal-form");
  if (form) {
    form.addEventListener("submit", handleAddColumn);
  }
  
  // Focus on the input field
  setTimeout(() => {
    const input = document.getElementById("col-name");
    if (input) {
      input.focus();
      input.select();
    }
  }, 100);
}

async function handleAddColumn(e) {
  e.preventDefault();
  const columnName = document.getElementById("col-name").value.trim();
  
  if (!columnName) {
    alert("Please enter a column name");
    return;
  }
  
  // Check if column already exists
  const currentHash = window.location.hash;
  const params = new URLSearchParams(currentHash.split("?")[1]);
  const projectId = params.get("id");
  
  // Get existing columns from localStorage or use defaults
  const storageKey = `crm_cols_${projectId}`;
  let existingCols = JSON.parse(localStorage.getItem(storageKey) || "[]");
  
  // Merge with default columns if not already done
  if (existingCols.length === 0) {
    existingCols = [...DEFAULT_COLS];
  }
  
  // Check for duplicates (case-insensitive)
  if (existingCols.some(col => col.toLowerCase() === columnName.toLowerCase())) {
    alert("A column with this name already exists");
    return;
  }
  
  // Add new column
  existingCols.push(columnName);
  localStorage.setItem(storageKey, JSON.stringify(existingCols));
  
  // Update global columns
  if (typeof window !== "undefined") {
    window.GLOBAL_CRM_COLS = existingCols;
  }
  
  closeModal();
  
  // Refresh the CRM tab
  const project = { id: projectId };
  crmTab(project).then(html => {
    const crmContainer = document.getElementById("crm-container");
    if (crmContainer) {
      crmContainer.innerHTML = html;
      enableDragDrop(projectId);
      
      // Reattach event handlers
      attachCRMEventHandlers(projectId);
    }
  });
}

// Make showAddColumnModal globally accessible
if (typeof window !== "undefined") {
  window.showAddColumnModal = showAddColumnModal;
}

function attachCRMEventHandlers(projectId) {
  // Reattach dropdown and buttons
  const dd = document.getElementById("crm-add-dd");
  const menu = document.getElementById("crm-add-menu");
  
  if (dd && menu) {
    dd.onclick = (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === "none" ? "block" : "none";
    };
    
    menu.querySelectorAll(".dropdown-item").forEach(btn =>
      btn.addEventListener("click", (e) => {
        const type = e.currentTarget.dataset.type;
        showTaskModal(projectId, "New", type);
        menu.style.display = "none";
      })
    );
  }
}

const taskCardHtml = (t, index) => {
  const taskTitle = t.task_name || "Untitled Task";
  const dueDate = t.due_date ? new Date(t.due_date) : null;

  // 🔹 Show index number
  const taskNumber = t.display_index || "";

  // 🔹 Assignee initials (max 2)
  const assignedPeople = (t.assigned_to || "")
    .split(",")
    .map((name) => name.trim().toUpperCase())
    .filter(Boolean)
    .map((n) => {
      const parts = n.split(" ");
      const initials =
        parts.length >= 2 ? parts[0][0] + parts[1][0] : n.slice(0, 2); // force 2 letters

      return `<span class="asg">${initials}</span>`;
    })
    .join("");

  // 🔹 Due date style
  let dueColor = "green";
  if (dueDate) {
    const today = new Date();
    const diffDays = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));

    if (diffDays < 0) dueColor = "red";
    else if (diffDays <= 1) dueColor = "orange";
  }

  const dueString = dueDate
    ? dueDate.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    })
    : "—";

  return `
    <div class="kan-card modern" draggable="true" data-id="${t.guid}">
      <div class="card-top">
        <span class="card-title"><strong>${taskNumber ? taskNumber + ". " : ""
    }${taskTitle}</strong></span>
      </div>

      <div class="card-mid">
        <div class="assignees">${assignedPeople || ""}</div>
      </div>
      
      <div class="task-separator"></div>

      <div class="card-bottom" style="margin-top:6px;">
        <span class="due-pill ${dueColor}">${dueString}</span>
      </div>
    </div>
  `;
};

const enableDragDrop = (projectId, boardId) => {
  const lists = document.querySelectorAll(".kan-list");

  lists.forEach((list) => {
    // Allow dropping
    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      list.classList.add("drop-active");
    });

    list.addEventListener("dragleave", () => {
      list.classList.remove("drop-active");
    });

    // Handle drop
    list.addEventListener("drop", async (e) => {
      e.preventDefault();
      list.classList.remove("drop-active");

      const cardId = e.dataTransfer.getData("text/plain");
      const newCol = list.getAttribute("data-col").trim();
      const card = document.querySelector(`.kan-card[data-id="${cardId}"]`);
      const currentCol = card
        ?.closest(".kan-list")
        ?.getAttribute("data-col")
        ?.trim();

      if (!card || !newCol || !currentCol) return;
      if (currentCol === newCol) return;

      // Move visually
      list.appendChild(card);
      card.classList.add("drop-animate");
      setTimeout(() => card.classList.remove("drop-animate"), 400);

      // Update backend
      const res = await moveTask(projectId, cardId, newCol);
      if (res.success) {
        console.log(`✅ Task moved to ${newCol}`);
        setTimeout(() => renderProjectDetails(projectId, "crm"), 300);
      } else {
        alert("❌ Move failed: " + (res.error || "Unknown error"));
      }
    });
  });

  // Draggable cards
  const cards = document.querySelectorAll(".kan-card");

  cards.forEach((card) => {
    // Drag start
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", card.dataset.id);
      e.dataTransfer.effectAllowed = "move";

      // 🔥 Custom drag ghost so cursor NEVER disappears on white card
      const dragGhost = document.createElement("div");
      dragGhost.style.width = "140px";
      dragGhost.style.height = "40px";
      dragGhost.style.background = "rgba(0,0,0,0.45)";
      dragGhost.style.borderRadius = "6px";
      dragGhost.style.position = "absolute";
      dragGhost.style.top = "-1000px"; // hide it
      document.body.appendChild(dragGhost);

      e.dataTransfer.setDragImage(dragGhost, 70, 20);

      card.classList.add("dragging");

      setTimeout(() => dragGhost.remove(), 30);
    });

    // Drag end
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
    });

    // Click to open details
    card.addEventListener("click", (e) => {
      const taskId = card.dataset.id;
      if (taskId) openTaskDetailsPage(projectId, taskId);
    });
  });
  enableHorizontalAutoScroll();
  enableVerticalAutoScroll();
};
function enableVerticalAutoScroll() {
  let isDragging = false;
  let rafId = null;
  let currentScrollTarget = null;
  let pendingDelta = 0;

  // Optional debug — set to true to see logs
  const DEBUG = false;

  // Utility: find the nearest scrollable ancestor under the point
  function findScrollableAtPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    if (!el) return document.scrollingElement || document.body;

    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      const canScroll =
        el.scrollHeight > el.clientHeight &&
        (overflowY === "auto" ||
          overflowY === "scroll" ||
          overflowY === "overlay");
      if (canScroll) return el;
      el = el.parentElement;
    }
    // fallback to the app-area or page scroll
    return (
      document.querySelector("#app-content") ||
      document.querySelector(".page-body") ||
      document.scrollingElement ||
      document.body
    );
  }

  function applyScroll() {
    if (!isDragging) {
      pendingDelta = 0;
      currentScrollTarget = null;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      return;
    }

    if (pendingDelta !== 0 && currentScrollTarget) {
      // Use scrollBy so browsers maintain scroll behavior
      try {
        currentScrollTarget.scrollBy({
          top: pendingDelta,
          left: 0,
          behavior: "auto",
        });
      } catch (err) {
        // fallback for older browsers
        currentScrollTarget.scrollTop += pendingDelta;
      }
      if (DEBUG) console.log("v-scroll", currentScrollTarget, pendingDelta);
      // decay/pause rather than continuous accumulation
      pendingDelta = 0;
    }

    rafId = requestAnimationFrame(applyScroll);
  }

  document.addEventListener("dragstart", () => {
    isDragging = true;
    if (!rafId) applyScroll();
  });

  document.addEventListener("dragend", () => {
    isDragging = false;
  });

  document.addEventListener(
    "dragover",
    (e) => {
      if (!isDragging) return;

      // determine best scroll container under cursor
      const scrollTarget = findScrollableAtPoint(e.clientX, e.clientY);
      currentScrollTarget = scrollTarget;

      // zone sizes and speed tuning
      const topZone = 120;
      const bottomZone = 120;
      const maxSpeed = 28; // px per frame (tweakable)

      // compute mouse relative to scrollTarget rect
      const rect = scrollTarget.getBoundingClientRect();
      const y = e.clientY;

      let scrollAmount = 0;

      // if pointer near top of scroll container -> scroll up
      if (y < rect.top + topZone) {
        const pct = (rect.top + topZone - y) / topZone;
        scrollAmount = -Math.min(maxSpeed, Math.ceil(pct * maxSpeed));
      }
      // if near bottom -> scroll down
      else if (y > rect.bottom - bottomZone) {
        const pct = (y - (rect.bottom - bottomZone)) / bottomZone;
        scrollAmount = Math.min(maxSpeed, Math.ceil(pct * maxSpeed));
      }

      // accumulate delta for rAF to apply (keeps scrolling smooth)
      pendingDelta += scrollAmount;

      // prevent default to allow drop targets to receive events
      e.preventDefault();
    },
    { passive: false }
  );
}


// ============================
// 📌 Auto-scroll while dragging
// ============================
function enableHorizontalAutoScroll() {
  const wrap = document.querySelector(".kan-wrap");
  if (!wrap) return;

  let scrollSpeed = 15;

  wrap.addEventListener("dragover", (e) => {
    const bounding = wrap.getBoundingClientRect();
    const x = e.clientX;

    const leftEdge = bounding.left + 80; // 80px from left
    const rightEdge = bounding.right - 80; // 80px from right

    if (x < leftEdge) {
      wrap.scrollLeft -= scrollSpeed; // scroll left
    } else if (x > rightEdge) {
      wrap.scrollLeft += scrollSpeed; // scroll right
    }
  });
}

// ==========================
// ✅ Move Task (PATCH Status)
// ==========================
async function moveTask(projectId, taskId, newCol) {
  try {
    const payload = { task_status: newCol };

    const res = await fetch(`${API_ROOT}/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    return data;
  } catch (err) {
    console.error("moveTask error:", err);
    return { success: false, error: err.message };
  }
}

// ==========================
// Add New Task Modal
// ==========================
function showTaskModal(projectId, defaultStatus = "New") {
  const currentHash = window.location.hash;
  const params = new URLSearchParams(currentHash.split("?")[1]);
  const boardParam = params.get("board") || "General";
  const boardName = params.get("boardName") || boardParam;

  // ✅ Redirect to full page form instead of modal
  renderTaskFormPage(projectId, boardParam, defaultStatus);
}
// this fun for multi select for assigned to
function initMultiSelect(elementId, items) {
  const wrapper = document.getElementById(elementId);
  const selectedContainer = wrapper.querySelector(".selected-items");
  const dropdown = wrapper.querySelector(".dropdown");
  const search = wrapper.querySelector(".search-input");

  let selected = [];

  wrapper.addEventListener("click", () => {
    dropdown.style.display = "block";
    search.focus();
  });

  document.addEventListener("click", (e) => {
    if (!wrapper.contains(e.target)) dropdown.style.display = "none";
  });

  function renderDropdown(filter = "") {
    dropdown.innerHTML = "";
    items
      .filter((i) => i.name.toLowerCase().includes(filter.toLowerCase()))
      .forEach((i) => {
        const div = document.createElement("div");
        div.textContent = i.name;
        div.addEventListener("click", () => toggleItem(i));
        dropdown.appendChild(div);
      });
  }

  function toggleItem(item) {
    if (selected.some((s) => s.id === item.id)) {
      selected = selected.filter((s) => s.id !== item.id);
    } else {
      selected.push(item);
    }
    renderSelected();
  }

  function renderSelected() {
    selectedContainer.innerHTML = "";

    selected.forEach((s) => {
      const tag = document.createElement("div");
      tag.className = "selected-tag";
      tag.innerHTML = `${s.name} <span data-id="${s.id}">×</span>`;

      tag.querySelector("span").addEventListener("click", () => {
        selected = selected.filter((x) => x.id !== s.id);
        renderSelected();
      });

      selectedContainer.appendChild(tag);
    });
  }

  search.addEventListener("input", (e) => {
    renderDropdown(e.target.value);
  });

  renderDropdown();

  return {
    getSelected: () => selected,
    addSelected: (item) => {
      if (!selected.some((s) => s.id === item.id)) {
        selected.push(item);
        const selectedContainer = wrapper.querySelector(".selected-items");
        renderSelected();
      }
    },
  };
}

function renderTaskFormPage(projectId, boardName, defaultStatus = "New") {
  const app = document.getElementById("app-content");

  app.innerHTML = `
    <div class="card" style="max-width:900px; margin:0 auto; padding:24px 28px; border-radius:24px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h2 style="margin:0;">Add New Task</h2>
        <button id="task-back" class="btn btn-light" style="border-radius:999px; padding:0.45rem 1.1rem;">← Back</button>
      </div>
      <hr style="margin:12px 0;">
      <form id="task-form" class="form-grid two-col">
        <div class="form-field" style="grid-column:1 / -1;">
          <label class="form-label" for="tk-name">Title *</label>
          <input class="input-control" id="tk-name" type="text" placeholder="Enter task title" required />
        </div>

        <div class="form-field" style="grid-column:1 / -1;">
          <label class="form-label" for="tk-desc">Description</label>
          <textarea class="input-control" id="tk-desc" rows="3" placeholder="Task description"></textarea>
        </div>

        <div class="form-field" style="grid-column:1 / -1;">
          <label class="form-label" for="assignedTo">Assigned To</label>
          <div class="multi-select" id="assignedTo">
            <div class="selected-items"></div>
            <input 
              type="text" 
              placeholder="Touch to select users…" 
              class="search-input" 
            />
            <div class="dropdown"></div>
          </div>
        </div>

        <div class="form-field">
          <label class="form-label" for="tk-priority">Priority</label>
          <select class="input-control" id="tk-priority">
            <option>Low</option>
            <option selected>Medium</option>
            <option>High</option>
          </select>
        </div>

        <div class="form-field">
          <label class="form-label" for="tk-status">Status</label>
          <select class="input-control" id="tk-status" disabled>
            <option>${defaultStatus}</option>
          </select>
        </div>

        <div class="form-field">
          <label class="form-label" for="tk-assigneddate">Assigned Date</label>
          <input class="input-control" type="date" id="tk-assigneddate" />
        </div>

        <div class="form-field">
          <label class="form-label" for="tk-due">Due Date</label>
          <input class="input-control" type="date" id="tk-due" />
        </div>

        <div style="grid-column:1 / -1; display:flex; justify-content:flex-end; gap:12px; margin-top:0.5rem;">
          <button type="button" id="tk-cancel" class="btn btn-secondary">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Task</button>
        </div>
      </form>
    </div>
  `;

  // =========================
  // ✅ DATE VALIDATION (UI)
  // =========================
  const today = new Date().toISOString().split("T")[0];

  const assignedInput = document.getElementById("tk-assigneddate");
  assignedInput.setAttribute("min", today);
  assignedInput.value = today; // auto-set today
  assignedInput.readOnly = true; // ❌ user cannot change date

  document.getElementById("tk-due").setAttribute("min", today);

  // =========================
  // Load Contributors
  // =========================
  // ---- NEW MULTI-SELECT FOR ASSIGNED TO ----
  async function populateContributorsDropdown() {
    try {
      const res = await fetch(
        `${PROJECTS_API}/${projectId}/contributors`
      );
      const data = await res.json();

      if (!res.ok || !data.contributors) return;

      // Convert contributors into usable format
      const contributors = data.contributors.map((c) => ({
        id: c.employee_id || c.employeeId,
        name: c.employee_name || c.employeeName,
      }));

      // Initialize multi-select
      const assignedSelect = initMultiSelect("assignedTo", contributors);

      // Store selected getter globally so saving can access it
      window.getAssignedUsers = () => assignedSelect.getSelected();
    } catch (err) {
      console.error("Error fetching contributors:", err);
    }
  }

  populateContributorsDropdown();

  // =========================
  // CANCEL
  // =========================
  document.getElementById("task-back").onclick = () => {
    window.location.hash = `#/time-projects?id=${encodeURIComponent(
      projectId
    )}&tab=crm&board=${encodeURIComponent(boardParam)}&boardName=${encodeURIComponent(boardName)}`;
    renderProjectDetails(projectId, "crm");
  };
  document.getElementById("tk-cancel").onclick = () =>
    document.getElementById("task-back").click();

  // =========================
  // SAVE TASK (with date rules)
  // =========================
  document.getElementById("task-form").onsubmit = async (e) => {
    e.preventDefault();

    const startDate = document.getElementById("tk-assigneddate").value;
    const dueDate = document.getElementById("tk-due").value;

    if (startDate && startDate < today) {
      alert("⚠️ Start date cannot be before today.");
      return;
    }

    if (startDate && dueDate && dueDate < startDate) {
      alert("⚠️ Due date must be equal or greater than start date.");
      return;
    }

    // ✅ FIX — use your multi-select getter
    const assignedUsers = window.getAssignedUsers();
    const assignedTo = assignedUsers.map((u) => u.name).join(", ");

    const payload = {
      task_name: document.getElementById("tk-name").value.trim(),
      task_description: document.getElementById("tk-desc").value.trim(),
      task_priority: document.getElementById("tk-priority").value,
      task_status: defaultStatus,
      assigned_to: assignedTo, // ✅ FIXED
      assigned_date: startDate,
      due_date: dueDate,
      board_name: boardName,
    };

    const res = await fetch(
      `${API_ROOT}/api/projects/${projectId}/tasks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    const data = await res.json();
    if (res.ok && data.success) {
      alert("✅ Task created successfully!");
      window.location.hash = `#/time-projects?id=${encodeURIComponent(
        projectId
      )}&tab=crm&board=${encodeURIComponent(boardParam)}&boardName=${encodeURIComponent(boardName)}`;
      renderProjectDetails(projectId, "crm");
    } else {
      alert("❌ Failed: " + (data.error || "Unknown error"));
    }
  };
}

// ==========================
// Delete Task
// ==========================
async function deleteTask(taskId, projectId) {
  if (!confirm("🗑️ Delete this task?")) return;
  const res = await fetch(`${API_ROOT}/api/tasks/${taskId}`, {
    method: "DELETE",
  });
  const data = await res.json();
  if (res.ok && data.success) {
    alert("✅ Deleted");
    renderProjectDetails(projectId, "crm");
  } else {
    alert("❌ " + (data.error || "Failed to delete"));
  }
}

async function openTaskDetailsPage(projectId, taskId) {
  const app = document.getElementById("app-content");

  const res = await fetch(`${API_BASE}/api/tasks/${taskId}`);
  if (!res.ok) {
    const txt = await res.text();
    app.innerHTML = `<div class="placeholder-text">Failed to load task: ${txt}</div>`;
    return;
  }

  const data = await res.json();
  const t = data.task || {};

  app.innerHTML = `
    <div class="card" style="max-width:900px; margin:24px auto 32px; padding:24px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h2>${escapeHtml(t.task_name || "")}</h2>
        <button id="tk-back" class="btn btn-light">← Back</button>
      </div>
      <hr>

      <h3 class="form-section-title">Task Information</h3>

      <div class="form-grid-2col" id="task-detail-form">

        <div class="task-detail-group full-col"><label>Task Title</label>
          <input id="td-title" value="${escapeHtml(
    t.task_name || ""
  )}" readonly class="readonly-input">
        </div>

        <div class="task-detail-group full-col"><label>Description</label>
          <textarea id="td-desc" readonly class="readonly-input">${escapeHtml(
    t.task_description || ""
  )}</textarea>
        </div>

        <div class="task-detail-group">
          <label>Assigned To</label>

          <div class="multi-select" id="assignedToEdit">
              <div class="selected-items"></div>
              <input type="text" placeholder="Touch to select users..." class="search-input" />
              <div class="dropdown"></div>
          </div>

        </div>


        <div class="task-detail-group">
          <label>Status</label>
          <select id="td-status" class="readonly-input" disabled>
            ${window.GLOBAL_CRM_COLS.map(
    (s) =>
      `<option value="${s}" ${(t.task_status || "").toLowerCase() === s.toLowerCase()
        ? "selected"
        : ""
      }>${s}</option>`
  ).join("")}
          </select>
        </div>

        

        <div class="task-detail-group"><label>Priority</label>
          <input id="td-priority" value="${escapeHtml(
    t.task_priority || ""
  )}" readonly class="readonly-input">
        </div>

        <div class="task-detail-group"><label>Due Date</label>
          <input type="date" id="td-due" value="${t.due_date || ""
    }" readonly class="readonly-input">
        </div>

      </div>

      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px;">
        <button id="td-edit" class="btn btn-primary">Edit</button>
        <button id="td-del" class="btn btn-danger">Delete</button>
      </div>
    </div>
  `;
  // // 🔐 L1 cannot edit/delete inside task details
  // const role = localStorage.getItem("role") || "L1";
  // if (role === "L1") {
  //   document.getElementById("td-edit")?.remove();
  //   document.getElementById("td-del")?.remove();
  // }
  // ------------------------------
  // Contributors dropdown
  // ------------------------------
  // Initialize multi-select (same component as Add Task)
  async function loadAssignedToMultiSelect() {
    try {
      const res = await fetch(
        `${API_ROOT}/api/projects/${projectId}/contributors`
      );
      const data = await res.json();

      const contributors = data.contributors.map((c) => ({
        id: c.employee_id || c.employeeId,
        name: c.employee_name || c.employeeName,
      }));

      // Pre-selected values (convert from CSV string)
      const pre = (t.assigned_to || "")
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x);

      const multi = initMultiSelect("assignedToEdit", contributors);

      // Pre-select existing contributors
      contributors.forEach((user) => {
        if (pre.includes(user.name)) {
          multi.addSelected(user);
        }
      });

      // Expose getter for save action
      window.getAssignedUsersEdit = () => multi.getSelected();
    } catch (err) {
      console.error("AssignedTo load error:", err);
    }
  }

  loadAssignedToMultiSelect();

  // =========================
  // BACK BUTTON
  // =========================
  document.getElementById("tk-back").onclick = () => {
    const boardParam =
      new URLSearchParams(window.location.hash.split("?")[1] || "").get(
        "board"
      ) || "";

    window.location.hash = `#/time-projects?id=${encodeURIComponent(
      projectId
    )}&tab=crm${boardParam ? "&board=" + encodeURIComponent(boardParam) : ""}`;

    renderProjectDetails(projectId, "crm");
  };

  // =========================
  // EDIT MODE
  // =========================
  const editBtn = document.getElementById("td-edit");

  editBtn.onclick = async () => {
    const isEdit = editBtn.textContent.trim() === "Edit";

    const fields = document.querySelectorAll(
      "#task-detail-form input, #task-detail-form textarea, #task-detail-form select"
    );

    if (isEdit) {
      fields.forEach((f) => {
        f.removeAttribute("readonly");
        f.removeAttribute("disabled");
        f.classList.remove("readonly-input");
      });

      // Date UI rule
      const today = new Date().toISOString().split("T")[0];
      document.getElementById("td-due").setAttribute("min", today);

      editBtn.textContent = "Save";
    } else {
      const today = new Date().toISOString().split("T")[0];
      const dueDate = document.getElementById("td-due").value;

      // Rule: Due Date >= Today
      if (dueDate && dueDate < today) {
        alert("⚠️ Due date cannot be a past date.");
        return;
      }

      // Get selected users from multi-select
      const assignedList = window.getAssignedUsersEdit();
      const assignedTo = assignedList.map((u) => u.name).join(", ");

      const payload = {
        task_name: document.getElementById("td-title").value.trim(),
        task_description: document.getElementById("td-desc").value.trim(),
        task_priority: document.getElementById("td-priority").value.trim(),
        task_status: document.getElementById("td-status").value,
        assigned_to: assignedTo,
        due_date: dueDate,
      };

      const resPatch = await fetch(`${API_BASE}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const resp = await resPatch.json().catch(() => ({ success: false }));

      if (resPatch.ok && resp.success) {
        alert("Task updated!");
        renderProjectDetails(projectId, "crm");
      } else {
        alert("Update failed!");
      }
    }
  };

  // ----------------------------
  // DELETE TASK
  // ----------------------------
  const { canManage } = getProjectAccess();
  if (!canManage) {
    document.getElementById("td-edit")?.remove();
    document.getElementById("td-del")?.remove();
    return;
  }

  document.getElementById("td-del").onclick = async () => {
    await deleteTask(taskId, projectId);
  };
}

// ==========================
// Route entry point
// ==========================
export const renderProjectsRoute = async () => {
  // Ensure we have projects from backend/local seed
  await fetchProjects();

  // Parse hash query for deep links
  const { id, tab = "details", board } = getQuery();

  if (id) {
    renderProjectDetails(id, tab);
    // If board param present, pass through hash for CRM tab
    if (tab === "crm" && board) {
      // Try to get board name from URL parameters if it exists
      const hash = window.location.hash || "";
      const qs = hash.split("?")[1] || "";
      const params = new URLSearchParams(qs);
      const boardName = params.get("boardName") || board;
      
      window.location.hash = `#/time-projects?id=${encodeURIComponent(
        id
      )}&tab=crm&board=${encodeURIComponent(board)}&boardName=${encodeURIComponent(boardName)}`;
    }
  } else {
    renderList();
  }
};
