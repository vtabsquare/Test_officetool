// leaveTracker.js
import { state } from "../state.js";
import { getPageContentHTML } from "../utils.js";
import { renderModal, closeModal } from "../components/modal.js";
import {
  fetchEmployeeLeaves,
  fetchLeaveBalance,
  fetchTeamLeavesBatch,
} from "../features/leaveApi.js";
import {
  fetchLeaveQuota,
  validateLeaveBalance,
  calculateLeaveDays,
} from "../features/leaveQuotaApi.js";
import { listEmployees } from "../features/employeeApi.js";
import { renderMyAttendancePage } from "./attendance.js";
import {
  notifyAdminLeaveApplication,
  updateNotificationBadge,
} from "../features/notificationApi.js";
import { showLeaveApplicationToast } from "../components/toast.js";
import { isAdminUser } from "../utils/accessControl.js";

let leaveCurrentPage = 1;
const LEAVE_PAGE_SIZE = 10;
let leaveViewMode = "my"; // 'my' | 'team'

// Simple async pool to cap concurrent network calls
const runWithConcurrency = async (items, limit, worker) => {
  const results = [];
  let index = 0;
  const runners = Array(Math.min(limit, items.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const current = index++;
        if (current >= items.length) break;
        await worker(items[current], current, results);
      }
    });
  await Promise.all(runners);
  return results;
};

// Resolve the current user's employee_id robustly
const resolveCurrentEmployeeId = async () => {
  let empId = String(state.user?.id || "")
    .trim()
    .toUpperCase();
  const userName = state.user?.name;
  try {
    const allEmployees = await listEmployees(1, 5000);
    // Prefer exact ID match first
    if (empId && empId.startsWith("EMP")) {
      const matchId = (allEmployees.items || []).find(
        (e) => (e.employee_id || "").toUpperCase() === empId
      );
      if (matchId) return empId;
    }
    // Fallback: resolve by exact full name match
    if (userName) {
      const match = (allEmployees.items || []).find((e) => {
        const empFullName = `${e.first_name || ""} ${e.last_name || ""}`
          .trim()
          .toLowerCase();
        return empFullName === userName.toLowerCase().trim();
      });
      if (match && match.employee_id) {
        empId = match.employee_id.trim().toUpperCase();
        state.user.id = empId;
        try {
          localStorage.setItem(
            "auth",
            JSON.stringify({ authenticated: true, user: state.user })
          );
        } catch { }
        return empId;
      }
    }
    // Email fallback
    if (state.user?.email) {
      const matchEmail = (allEmployees.items || []).find(
        (e) =>
          (e.email || "").toLowerCase() ===
          String(state.user.email).toLowerCase()
      );
      if (matchEmail && matchEmail.employee_id) {
        empId = matchEmail.employee_id.trim().toUpperCase();
        state.user.id = empId;
        try {
          localStorage.setItem(
            "auth",
            JSON.stringify({ authenticated: true, user: state.user })
          );
        } catch { }
        return empId;
      }
    }
  } catch { }
  return empId;
};

// Fetch team leaves - for emp001, fetch ALL employee leaves; for others, only fetch department teammates
const fetchTeamLeavesByDepartment = async (currentEmpId) => {
  try {
    const allEmployees = await listEmployees(1, 5000);
    const items = allEmployees.items || [];
    const isAdmin = currentEmpId.toUpperCase() === "EMP001";

    // For admin (emp001), show all employees; for others, only show department teammates
    let teammates;
    if (isAdmin) {
      // Admin sees all employees except self
      teammates = items.filter(
        (e) => (e.employee_id || "").toUpperCase() !== currentEmpId
      );
      console.log(
        `✅ Admin user detected. Showing leaves for all ${teammates.length} employees`
      );
    } else {
      // Regular users only see department teammates
      const me = items.find(
        (e) => (e.employee_id || "").toUpperCase() === currentEmpId
      );
      const myDept = (me?.department || "").trim().toLowerCase();
      teammates = items.filter(
        (e) =>
          (e.employee_id || "").toUpperCase() !== currentEmpId &&
          (e.department || "").trim().toLowerCase() === myDept
      );
      console.log(
        `👥 Regular user. Showing leaves for ${teammates.length} department teammates`
      );
    }

    const leaves = [];
    const ids = teammates
      .map((tm) => String(tm.employee_id || tm.id || "").toUpperCase())
      .filter(Boolean);

    // Prefer aggregated endpoint; fallback to per-employee fetch pool
    let batchFailed = false;
    if (ids.length) {
      try {
        const batchLeaves = await fetchTeamLeavesBatch(ids);
        (batchLeaves || []).forEach((l) => {
          const tm = teammates.find(
            (t) =>
              String(t.employee_id || t.id || "").toUpperCase() ===
              String(l.employee_id || "").toUpperCase()
          );
          leaves.push({
            ...l,
            _employee_name: `${tm?.first_name || ""} ${tm?.last_name || ""}`.trim(),
          });
        });
      } catch (err) {
        console.warn("⚠️ Batch team leaves failed, falling back:", err);
        batchFailed = true;
      }
    }

    if (batchFailed || leaves.length === 0) {
      await runWithConcurrency(teammates, 8, async (tm) => {
        try {
          const tmLeaves = await fetchEmployeeLeaves(tm.employee_id);
          (tmLeaves || []).forEach((l) =>
            leaves.push({
              ...l,
              employee_id: tm.employee_id,
              _employee_name: `${tm.first_name || ""} ${tm.last_name || ""
                }`.trim(),
            })
          );
        } catch (err) {
          console.warn(
            "Failed to fetch leaves for teammate",
            tm.employee_id,
            err
          );
        }
      });
    }

    console.log(
      `✅ Total team leaves fetched: ${leaves.length} from ${teammates.length} employees`
    );
    return { teammates, leaves };
  } catch (err) {
    console.error("Failed to fetch team leaves:", err);
    return { teammates: [], leaves: [] };
  }
};

export const renderLeaveTrackerPage = async (
  page = leaveCurrentPage,
  forceRefresh = true
) => {
  console.log("📄 Rendering Leave Tracker Page - Fetching historical data...");
  console.log("🔄 Force refresh:", forceRefresh);

  // Check if we should show team view based on URL or saved mode
  const hash = window.location.hash;
  if (hash === "#/leave-team" || window.__leaveViewMode === "team") {
    leaveViewMode = "team";
  } else {
    leaveViewMode = "my";
  }
  console.log("🔍 Leave view mode set to:", leaveViewMode);

  // Show loading state first
  // Show Apply Leave button only in 'my' view
  const applyLeaveBtn =
    leaveViewMode === "my"
      ? `<button id="apply-leave-btn" class="btn btn-primary"><i class="fa-solid fa-plus"></i> APPLY LEAVE</button>`
      : "";

  const controls = `
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            ${applyLeaveBtn}
        </div>
    `;
  const loadingContent = `
        <div class="leave-quota-container">
            <div class="leave-quota-grid">
                <div class="leave-quota-card">
                    <div class="leave-quota-header">
                        <div class="skeleton skeleton-text" style="width: 60%; height: 18px;"></div>
                        <div class="skeleton skeleton-pill" style="width: 40px; height: 18px;"></div>
                    </div>
                    <div class="leave-quota-body">
                        <div class="skeleton skeleton-list-line-lg"></div>
                        <div class="skeleton skeleton-list-line-sm" style="margin-top: 4px;"></div>
                    </div>
                </div>
                <div class="leave-quota-card">
                    <div class="leave-quota-header">
                        <div class="skeleton skeleton-text" style="width: 60%; height: 18px;"></div>
                        <div class="skeleton skeleton-pill" style="width: 40px; height: 18px;"></div>
                    </div>
                    <div class="leave-quota-body">
                        <div class="skeleton skeleton-list-line-lg"></div>
                        <div class="skeleton skeleton-list-line-sm" style="margin-top: 4px;"></div>
                    </div>
                </div>
                <div class="leave-quota-card">
                    <div class="leave-quota-header">
                        <div class="skeleton skeleton-text" style="width: 60%; height: 18px;"></div>
                        <div class="skeleton skeleton-pill" style="width: 40px; height: 18px;"></div>
                    </div>
                    <div class="leave-quota-body">
                        <div class="skeleton skeleton-list-line-lg"></div>
                        <div class="skeleton skeleton-list-line-sm" style="margin-top: 4px;"></div>
                    </div>
                </div>
            </div>
        </div>
        <div class="card leave-history">
            <div class="card-heading" style="border-bottom:none; padding-bottom:0.5rem; margin-bottom:0.75rem;">
                <div class="skeleton skeleton-heading-md" style="width: 180px;"></div>
            </div>
            <div class="table-container">
                <div class="skeleton skeleton-chart-line"></div>
            </div>
        </div>
    `;
  document.getElementById("app-content").innerHTML = getPageContentHTML(
    "My Leaves",
    loadingContent,
    controls
  );

  // Fetch fresh data from the server (always on initial load or after applying leave)
  let fetchError = null;

  // My Leaves: fetch only for current user
  console.log("🔍 Checking leaveViewMode:", leaveViewMode);
  if (leaveViewMode === "my") {
    console.log("🔄 Fetching fresh data from server...");
    console.log("   - forceRefresh:", forceRefresh);
    console.log("   - Current state.leaves count:", state.leaves?.length || 0);

    try {
      let empId = await resolveCurrentEmployeeId();
      console.log("🔍 Using employee ID:", empId);

      // Use the imported fetchEmployeeLeaves function
      let leaves = await fetchEmployeeLeaves(empId);
      console.log("📊 Fetched leaves from API:", leaves?.length || 0);

      // Sort leaves by start_date descending (latest first)
      if (leaves && leaves.length > 0) {
        leaves.sort((a, b) => {
          const dateA = new Date(a.start_date || "1900-01-01");
          const dateB = new Date(b.start_date || "1900-01-01");
          return dateB - dateA; // Descending order (newest first)
        });
        console.log("📋 First leave record (latest):", leaves[0]);
        console.log(
          "📋 Last leave record (oldest):",
          leaves[leaves.length - 1]
        );
      } else {
        console.warn("⚠️ No leaves returned from API for employee ID:", empId);
      }

      // Fallback: if still no leaves and ID may be email, try resolving via email
      if ((!leaves || leaves.length === 0) && state.user?.email) {
        console.log(
          "⚠️ No leaves found, attempting to resolve employee ID from email..."
        );
        try {
          const all = await listEmployees(1, 5000);
          const match = (all.items || []).find(
            (e) =>
              (e.email || "").toLowerCase() ===
              String(state.user.email).toLowerCase()
          );
          if (
            match &&
            match.employee_id &&
            match.employee_id.toUpperCase() !== empId
          ) {
            empId = match.employee_id.toUpperCase();
            state.user.id = empId;
            try {
              localStorage.setItem(
                "auth",
                JSON.stringify({ authenticated: true, user: state.user })
              );
            } catch { }
            console.log("✅ Resolved employee ID from email:", empId);
            leaves = await fetchEmployeeLeaves(empId);
            console.log(
              "📊 Fetched leaves after email resolution:",
              leaves?.length || 0
            );
          }
        } catch (err) {
          console.warn("Failed to resolve employee ID from email:", err);
        }
      }

      // Fetch all employees to resolve email addresses to employee IDs
      let employeeMap = {};
      try {
        const allEmployees = await listEmployees(1, 5000);
        // Create a map of email -> employee_id for quick lookup
        (allEmployees.items || []).forEach((emp) => {
          if (emp.email && emp.employee_id) {
            employeeMap[emp.email.toLowerCase()] = emp.employee_id;
          }
        });
      } catch (err) {
        console.warn("Failed to fetch employees for email lookup:", err);
      }

      // Note: Do not try to resolve by name to avoid mismatches across users with similar names
      // Map to state format (leaves are already sorted)
      state.leaves = leaves.map((l) => {
        let appliedBy = l.employee_id;
        // If appliedBy contains '@', it's an email - lookup the employee ID
        if (appliedBy && appliedBy.includes("@")) {
          const resolvedId = employeeMap[appliedBy.toLowerCase()];
          if (resolvedId) {
            appliedBy = resolvedId;
          }
        }
        return {
          id: l.leave_id,
          startDate: l.start_date,
          endDate: l.end_date,
          leaveType: l.leave_type,
          appliedBy: appliedBy,
          approvalStatus: l.status || "Pending",
          leaveCount: l.total_days,
          appliedDate: l.start_date, // Use start_date as applied date if not stored
          compensationType: l.paid_unpaid,
        };
      });

      console.log(
        "✅ Leave data processed. Total leaves in state:",
        state.leaves.length
      );
      if (state.leaves.length > 0) {
        console.log("📋 Sample leave from state:", state.leaves[0]);
      }
    } catch (err) {
      console.error("❌ Failed to fetch leaves:", err);
      fetchError = err.message || "Failed to load leave history";
      if (!state.leaves) {
        state.leaves = []; // Ensure state.leaves is always an array
      }
    }
  } else if (leaveViewMode === "team") {
    // Team Leaves: fetch leave balances for all team members
    try {
      const empId = await resolveCurrentEmployeeId();
      console.log("🔍 Current employee ID for team leaves:", empId);

      // Only show team leaves for emp001 (case insensitive comparison)
      if (empId && empId.toUpperCase() === "EMP001") {
        console.log("✅ Employee is emp001, fetching team leave balances");

        // Fetch all employees (including the logged-in user)
        const allEmployees = await listEmployees(1, 5000);
        const teammates = allEmployees.items || [];

        console.log(
          `📊 Fetching leave balances for ${teammates.length} team members (including self)...`
        );

        // Fetch leave balances for each team member
        const teamBalances = [];
        for (const tm of teammates) {
          try {
            const response = await fetch(
              `http://localhost:5000/api/leave-balance/all/${encodeURIComponent(
                tm.employee_id
              )}`,
              {
                cache: "no-cache",
                headers: {
                  "Cache-Control": "no-cache",
                  Pragma: "no-cache",
                },
              }
            );

            if (response.ok) {
              const data = await response.json();
              if (data.success && data.balances) {
                const clBalance = data.balances.find(
                  (b) => b.type === "Casual Leave"
                );
                const slBalance = data.balances.find(
                  (b) => b.type === "Sick Leave"
                );
                const coBalance = data.balances.find(
                  (b) => b.type === "Comp off"
                );
                const totalBalance = data.balances.find(
                  (b) => b.type === "Total"
                );

                teamBalances.push({
                  employeeId: tm.employee_id,
                  employeeName: `${tm.first_name || ""} ${tm.last_name || ""
                    }`.trim(),
                  cl: clBalance?.available || 0,
                  sl: slBalance?.available || 0,
                  compOff: coBalance?.available || 0,
                  total: totalBalance?.available || 0,
                });
              }
            }
          } catch (err) {
            console.warn(`Failed to fetch balance for ${tm.employee_id}:`, err);
          }
        }

        // Store in state for rendering
        state.teamBalances = teamBalances;
        console.log(
          `👥 Team balances loaded: ${teamBalances.length} employees`
        );
      } else {
        // For other employees, show empty team leaves
        state.teamBalances = [];
        console.log("Team leaves restricted: Only emp001 can view team leaves");
      }
    } catch (err) {
      console.error("❌ Failed to fetch team leave balances:", err);
      fetchError = err.message || "Failed to load team leave balances";
      state.teamBalances = [];
    }
  } else {
    console.log(
      "📦 Using cached leave data:",
      state.leaves?.length || 0,
      "leaves"
    );
    console.log(
      "🔍 Leave view mode was:",
      leaveViewMode,
      "- this should not happen for 'my' mode"
    );
  }

  console.log(
    "📊 Final state before rendering - Total leaves:",
    state.leaves?.length || 0
  );

  // For leave tracker page, just show all leaves without tab filtering
  let filteredLeaves = state.leaves || [];

  // Sort again by start date descending (latest first) to ensure proper order
  filteredLeaves.sort((a, b) => {
    const dateA = new Date(a.startDate || "1900-01-01");
    const dateB = new Date(b.startDate || "1900-01-01");
    return dateB - dateA; // Descending order (newest first)
  });

  console.log(
    `📊 Total leaves to display: ${filteredLeaves.length} (sorted latest first)`
  );
  if (filteredLeaves.length > 0) {
    console.log(
      `   📅 First (latest): ${filteredLeaves[0].startDate} - ${filteredLeaves[0].leaveType}`
    );
    console.log(
      `   📅 Last (oldest): ${filteredLeaves[filteredLeaves.length - 1].startDate
      } - ${filteredLeaves[filteredLeaves.length - 1].leaveType}`
    );
  }

  // Pagination setup
  const totalCount = filteredLeaves.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / LEAVE_PAGE_SIZE));
  leaveCurrentPage = Math.min(Math.max(1, page || 1), totalPages);
  const startIdx = (leaveCurrentPage - 1) * LEAVE_PAGE_SIZE;
  const paginatedLeaves = filteredLeaves.slice(
    startIdx,
    startIdx + LEAVE_PAGE_SIZE
  );
  const prevDisabled = leaveCurrentPage <= 1 ? "disabled" : "";
  const nextDisabled = leaveCurrentPage >= totalPages ? "disabled" : "";
  const prevPage = Math.max(1, leaveCurrentPage - 1);
  const nextPage = Math.min(totalPages, leaveCurrentPage + 1);

  // Generate table rows - different for team vs my leaves
  let tableRows = "";
  if (leaveViewMode === "team") {
    // Team view: Show leave balances
    const teamBalances = state.teamBalances || [];
    tableRows = teamBalances
      .map(
        (tb) => `
            <tr>
                <td>${tb.employeeName || "-"}</td>
                <td>${tb.employeeId || "-"}</td>
                <td>${tb.cl}</td>
                <td>${tb.sl}</td>
                <td>${tb.compOff}</td>
                <td><strong>${tb.total}</strong></td>
            </tr>
        `
      )
      .join("");
  } else {
    // My leaves: Show leave history
    tableRows = paginatedLeaves
      .map(
        (l) => `
            <tr>
                <td>${l.appliedBy || "-"}</td>
                <td>${l.leaveType}</td>
                <td>${l.startDate}</td>
                <td>${l.endDate}</td>
                <td>${l.leaveCount}</td>
                <td>${l.compensationType || "-"}</td>
                <td><span class="status-badge ${(
            l.approvalStatus || "pending"
          ).toLowerCase()}">${l.approvalStatus || "Pending"}</span></td>
            </tr>
        `
      )
      .join("");
  }

  const paginator = `
        <div class="pagination">
            <button id="leave-prev" class="btn" ${prevDisabled} data-target-page="${prevPage}"><i class="fa-solid fa-chevron-left"></i> Prev</button>
            <span class="page-indicator">Page ${leaveCurrentPage} of ${totalPages}</span>
            <button id="leave-next" class="btn" ${nextDisabled} data-target-page="${nextPage}">Next <i class="fa-solid fa-chevron-right"></i></button>
        </div>
    `;

  const myLeaveColumns = [
    { key: "appliedBy", label: "Employee ID", sorted: false },
    { key: "leaveType", label: "Leave Type", sorted: false },
    { key: "startDate", label: "Start Date", sorted: true, direction: "desc" },
    { key: "endDate", label: "End Date", sorted: false },
    { key: "leaveCount", label: "Days", sorted: false },
    { key: "compensationType", label: "Type", sorted: false },
    { key: "approvalStatus", label: "Status", sorted: false },
  ];

  const teamLeaveColumns = [
    { key: "employeeName", label: "Employee" },
    { key: "employeeId", label: "Employee ID" },
    { key: "cl", label: "Casual Leave" },
    { key: "sl", label: "Sick Leave" },
    { key: "compOff", label: "Comp Off" },
    { key: "total", label: "Total Quota" },
  ];

  const activeColumns =
    leaveViewMode === "team" ? teamLeaveColumns : myLeaveColumns;

  const tableHeaders = activeColumns
    .map((col) => {
      const isSorted = col.sorted;
      const direction = col.direction || "asc";
      const sortedClass = isSorted
        ? direction === "asc"
          ? " th-sorted th-sorted-asc"
          : " th-sorted th-sorted-desc"
        : "";
      return `
                        <th class="th-sortable${sortedClass}" data-column-key="${col.key}">
                            <span class="th-label">${col.label}</span>
                            <span class="th-sort-icons" aria-hidden="true">
                                <i class="fa-solid fa-chevron-up"></i>
                                <i class="fa-solid fa-chevron-down"></i>
                            </span>
                        </th>
                    `;
    })
    .join("");

  const columnsPanelItems = activeColumns
    .map(
      (col) => `
                        <label class="columns-option">
                            <input type="checkbox" checked data-column-key="${col.key}">
                            <span>${col.label}</span>
                        </label>
                    `
    )
    .join("");

  let emptyMessage = "";
  const extraCols = leaveViewMode === "team" ? 6 : 7;
  if (fetchError) {
    emptyMessage = `<tr><td colspan="${extraCols}" class="placeholder-text error-message">❌ Error: ${fetchError}. Please check if the backend server is running.</td></tr>`;
  } else if (
    leaveViewMode === "team" &&
    (!state.teamBalances || state.teamBalances.length === 0)
  ) {
    emptyMessage = `<tr><td colspan="${extraCols}" class="placeholder-text">No team members found.</td></tr>`;
  } else if (leaveViewMode === "my" && totalCount === 0) {
    emptyMessage = `<tr><td colspan="${extraCols}" class="placeholder-text">No leave history found. Apply for leave using the APPLY LEAVE button.</td></tr>`;
  }

  // Fetch real-time leave balances for quota cards
  let quotaCardsHTML = "";
  if (leaveViewMode === "my") {
    try {
      const empId = await resolveCurrentEmployeeId();
      console.log(`🔄 Fetching real-time leave balances for: ${empId}`);

      // Fetch all leave balances
      const response = await fetch(
        `http://localhost:5000/api/leave-balance/all/${encodeURIComponent(
          empId
        )}`,
        {
          cache: "no-cache",
          headers: {
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
          },
        }
      );

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.balances) {
          console.log(`✅ Leave balances fetched:`, data.balances);

          // Filter to show only the main leave types (CL, SL, Comp Off) for the summary cards
          quotaCardsHTML = data.balances
            .filter((balance) =>
              ["Casual Leave", "Sick Leave", "Comp off"].includes(balance.type)
            )
            .map((balance) => {
              const { type, annual_quota, consumed, available } = balance;

              // Calculate percentage for horizontal progress bar
              let consumedPercentage = 0;
              if (annual_quota > 0) {
                consumedPercentage = (consumed / annual_quota) * 100;
              }
              const safePercent = Math.max(0, Math.min(100, consumedPercentage));

              const shortCode =
                type === "Casual Leave" ? "CL" :
                type === "Sick Leave" ? "SL" :
                "CO";

              return `
                                <div class="leave-quota-card">
                                    <div class="leave-quota-header">
                                        <div>
                                            <div class="leave-quota-type">${shortCode}</div>
                                            <div class="leave-quota-title">${type}</div>
                                        </div>
                                        <div class="leave-quota-available">
                                            <div class="quota-available">${available}</div>
                                            <div class="quota-label">days available</div>
                                        </div>
                                    </div>
                                    <div class="quota-progress">
                                        <div class="quota-progress-fill" style="width: ${safePercent}%;"></div>
                                    </div>
                                    <div class="quota-meta">
                                        <span><span class="legend-dot dot-total"></span>Quota: ${annual_quota}</span>
                                        <span><span class="legend-dot dot-consumed"></span>Used: ${consumed}</span>
                                    </div>
                                </div>
                            `;
            })
            .join("");
        } else {
          console.warn("⚠️ Failed to fetch leave balances:", data.error);
        }
      } else {
        console.error(
          "❌ HTTP Error fetching leave balances:",
          response.status
        );
      }
    } catch (err) {
      console.error("❌ Error fetching leave balances:", err);
    }
  }

  const finalContent = `
        ${leaveViewMode === "my" && quotaCardsHTML
      ? `<div class="leave-quota-grid">${quotaCardsHTML}</div>`
      : ""
    }
        <div class="card leave-history data-table-card">
            <div class="leave-table-header">
                <div class="leave-table-title-group">
                    <h3>${leaveViewMode === "team"
      ? "Team Leave Balances"
      : "My Leave History"
    }</h3>
                    <p class="leave-table-subtitle">${leaveViewMode === "team"
      ? "Live balances for your team members"
      : "Timeline of your leave requests and approvals"
    }</p>
                </div>
                <div class="leave-table-toolbar">
                    <div class="leave-table-filters">
                        <button type="button" class="filter-chip">
                            <i class="fa-solid fa-filter"></i>
                            <span>Filters</span>
                            <span class="filter-chip-count">0</span>
                        </button>
                    </div>
                    <div class="leave-table-actions">
                        <div class="columns-control">
                            <input type="checkbox" id="leave-columns-toggle" class="columns-toggle-input" />
                            <label for="leave-columns-toggle" class="columns-button">
                                <i class="fa-solid fa-table-columns"></i>
                                <span>Columns</span>
                                <i class="fa-solid fa-chevron-down columns-button-caret"></i>
                            </label>
                            <div class="columns-panel" aria-labelledby="leave-columns-toggle">
                                <div class="columns-panel-header">
                                    <span class="columns-panel-title">Columns</span>
                                </div>
                                <div class="columns-panel-search">
                                    <i class="fa-solid fa-search"></i>
                                    <input type="text" placeholder="Search column type" />
                                </div>
                                <div class="columns-panel-body">
                                    <label class="columns-option columns-select-all">
                                        <input type="checkbox" checked />
                                        <span>Select all</span>
                                    </label>
                                    <div class="columns-option-list">
                                        ${columnsPanelItems}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="table-container leave-table-scroll">
                <table class="table leave-table">
                    <thead><tr>${tableHeaders}</tr></thead>
                    <tbody>${tableRows || emptyMessage}</tbody>
                </table>
            </div>
            ${leaveViewMode === "my" ? paginator : ""}
        </div>
    `;

  document.getElementById("app-content").innerHTML = getPageContentHTML(
    leaveViewMode === "team" ? "My Team Leaves" : "My Leaves",
    finalContent,
    controls
  );
  console.log(
    "✅ Leave Tracker Page rendered successfully with",
    totalCount,
    "leaves"
  );

  // Hook up event listeners
  setTimeout(async () => {
    // View selector (if exists)
    const viewSel = document.getElementById("leave-view-select");
    if (viewSel) {
      viewSel.addEventListener("change", async (e) => {
        const val = e.target.value === "team" ? "team" : "my";
        leaveViewMode = val;
        if (typeof window !== "undefined") {
          window.__leaveViewMode = leaveViewMode;
          const targetHash =
            leaveViewMode === "team" ? "#/leave-team" : "#/leave-my";
          if (window.location.hash !== targetHash) {
            window.location.hash = targetHash;
            return;
          }
        }
        await renderLeaveTrackerPage(1, true);
      });
    }
  }, 0);
};

export const showApplyLeaveModal = () => {
  console.log("📝 Opening Apply Leave Modal");

  // Get today's date in YYYY-MM-DD format
  const today = new Date().toISOString().split("T")[0];

  const formHTML = `
        <div class="leave-form">
            <div class="form-section">
                <div class="form-section-header">
                    <div>
                        <p class="form-eyebrow">Leave preferences</p>
                        <h3>Request details</h3>
                    </div>
                    <p class="form-section-copy">Choose the leave type, payout preference and dates.</p>
                </div>
                <div class="form-grid two-col">
                    <div class="form-field with-icon">
                        <label class="form-label" for="leaveType">Leave Type</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-briefcase"></i>
                            <select class="input-control" id="leaveType" name="leaveType" required>
                                <option value="" disabled selected>Select leave type</option>
                                <option value="Casual Leave">Casual Leave</option>
                                <option value="Sick Leave">Sick Leave</option>
                                <option value="Comp Off">Comp Off</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-field with-icon">
                        <label class="form-label" for="compensationType">Compensation Type</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-dollar-sign"></i>
                            <select class="input-control" id="compensationType" name="compensationType" required>
                                <option value="" disabled selected>Select compensation</option>
                                <option value="Paid">Paid</option>
                                <option value="Unpaid">Unpaid</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-field with-icon">
                        <label class="form-label" for="startDate">Start Date</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-calendar"></i>
                            <input class="input-control" type="date" id="startDate" name="startDate" min="${today}" required>
                        </div>
                    </div>
                    <div class="form-field with-icon">
                        <label class="form-label" for="endDate">End Date</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-calendar"></i>
                            <input class="input-control" type="date" id="endDate" name="endDate" min="${today}" required>
                        </div>
                    </div>
                </div>
            </div>

            <div class="form-section">
                <div class="form-field">
                    <div class="field-header">
                        <label class="form-label" for="reason">Reason</label>
                        <span class="field-hint">Share a concise context for reviewers</span>
                    </div>
                    <textarea class="input-control" id="reason" name="reason" rows="3" placeholder="Brief reason for your leave" required></textarea>
                    <p class="helper-text">Tip: keep it professional and note split-day nuances if any.</p>
                </div>
            </div>

            <div id="leave-balance-card" class="leave-balance-card">
                <div class="balance-header">
                    <div>
                        <p class="form-eyebrow">Availability</p>
                        <h4>Leave balance summary</h4>
                    </div>
                    <span class="balance-pill">Live sync</span>
                </div>
                <div class="leave-balance-grid">
                    <div class="balance-stat">
                        <span class="balance-label">CL</span>
                        <span id="bal-cl" class="balance-value">-</span>
                    </div>
                    <div class="balance-stat">
                        <span class="balance-label">SL</span>
                        <span id="bal-sl" class="balance-value">-</span>
                    </div>
                    <div class="balance-stat">
                        <span class="balance-label">Comp Off</span>
                        <span id="bal-co" class="balance-value">-</span>
                    </div>
                    <div class="balance-stat">
                        <span class="balance-label">Total</span>
                        <span id="bal-total" class="balance-value">-</span>
                    </div>
                    <div class="balance-stat">
                        <span class="balance-label">Actual Total</span>
                        <span id="bal-actual-total" class="balance-value">-</span>
                    </div>
                </div>
                <div id="leave-preview-msg" class="leave-preview-msg"></div>
            </div>
        </div>
    `;

  renderModal("Apply Leave", formHTML, "submit-leave-btn");
  console.log("✅ Apply Leave Modal displayed");

  // After render, wire up dynamic Paid/Unpaid enablement based on balance
  setTimeout(async () => {
    try {
      const empId = await resolveCurrentEmployeeId();
      const leaveSel = document.getElementById("leaveType");
      const compSel = document.getElementById("compensationType");
      const startInput = document.getElementById("startDate");
      const endInput = document.getElementById("endDate");

      const computeRequestedDays = () => {
        const s = startInput.value;
        const e = endInput.value;
        if (!s || !e) return 1;
        try {
          return Math.max(1, calculateLeaveDays(s, e));
        } catch {
          return 1;
        }
      };

      const refreshCompensationOptions = async () => {
        if (!leaveSel || !compSel) return;
        const leaveType = leaveSel.value;
        const paidOption = Array.from(compSel.options).find(
          (o) => o.value === "Paid"
        );

        if (leaveType === "Casual Leave" || leaveType === "Sick Leave") {
          if (paidOption) paidOption.disabled = false;
          compSel.classList.remove("disabled-option");
          return;
        }

        let available = 0;
        try {
          available = await fetchLeaveBalance(empId, leaveType);
        } catch { }
        const requested = computeRequestedDays();
        const canPay = Number(available) >= Number(requested);
        if (paidOption) {
          paidOption.disabled = !canPay;
        }
        if (!canPay && compSel.value === "Paid") {
          compSel.value = "Unpaid";
        }
        compSel.classList.toggle("disabled-option", !canPay);
      };

      // Load and display live balance + auto-set Paid/Unpaid preview
      const updateBalanceCardAndPreview = async () => {
        try {
          console.log("🔄 Fetching leave balances for employee:", empId);

          let clAvail = 0;
          let slAvail = 0;
          let coAvail = 0;
          let totalAvail = 0;
          let actualTotalAvail = 0;

          // Fetch all leave balances from backend
          const response = await fetch(
            `http://localhost:5000/api/leave-balance/all/${encodeURIComponent(
              empId
            )}`,
            {
              cache: "no-cache",
              headers: {
                "Cache-Control": "no-cache",
                Pragma: "no-cache",
              },
            }
          );

          console.log("📡 Response status:", response.status);

          if (response.ok) {
            const data = await response.json();
            console.log("📊 Leave balance data received:", data);

            if (data.success && data.balances) {
              console.log("✅ Balances array:", data.balances);

              const clBalance = data.balances.find(
                (b) => b.type === "Casual Leave"
              );
              const slBalance = data.balances.find(
                (b) => b.type === "Sick Leave"
              );
              const coBalance = data.balances.find(
                (b) => b.type === "Comp off"
              );
              const totalBalance = data.balances.find(
                (b) => b.type === "Total"
              );
              const actualTotalBalance = data.balances.find(
                (b) => b.type === "Actual Total"
              );

              clAvail = Number(clBalance?.available || 0);
              slAvail = Number(slBalance?.available || 0);
              coAvail = Number(coBalance?.available || 0);
              totalAvail = Number(totalBalance?.available || 0);
              actualTotalAvail = Number(actualTotalBalance?.available || 0);

              console.log("📋 Found balances:", {
                CL: clAvail,
                SL: slAvail,
                CO: coAvail,
                Total: totalAvail,
                ActualTotal: actualTotalAvail,
              });

              const clEl = document.getElementById("bal-cl");
              const slEl = document.getElementById("bal-sl");
              const coEl = document.getElementById("bal-co");
              const totEl = document.getElementById("bal-total");
              const actualTotEl = document.getElementById("bal-actual-total");

              if (clEl) clEl.textContent = String(clAvail);
              if (slEl) slEl.textContent = String(slAvail);
              if (coEl) coEl.textContent = String(coAvail);
              if (totEl) totEl.textContent = String(totalAvail);
              if (actualTotEl) actualTotEl.textContent = String(
                actualTotalAvail || 8
              );

              console.log("✅ Updated balance display successfully");
            } else {
              console.warn("⚠️ Invalid response structure:", data);
            }
          } else {
            console.error(
              "❌ Failed to fetch balances, status:",
              response.status
            );
          }

          const s = startInput.value;
          const e = endInput.value;
          if (s && e) {
            const req = computeRequestedDays();
            const msgEl = document.getElementById("leave-preview-msg");
            if (msgEl) {
              const type = leaveSel.value;
              let msg = "";
              if (type === "Casual Leave" || type === "Sick Leave") {
                const avail = type === "Casual Leave" ? clAvail : slAvail;
                const paidDays = Math.min(avail, req);
                const unpaidDays = Math.max(0, req - paidDays);
                msg = `You are applying for ${req} ${type} day(s).Available: ${avail}. This will be auto - split as ${paidDays} day(s) Paid and ${unpaidDays} day(s) Unpaid.`;
              } else if (type === "Comp Off") {
                const avail = coAvail;
                const canPay = avail >= req;
                msg = canPay
                  ? `You have ${avail} Comp Off day(s) available.This leave will be marked as PAID.`
                  : `Insufficient Comp Off balance(Available: ${avail}, Requested: ${req}).This leave will be UNPAID(LOP).`;
              } else {
                msg = `You are applying for ${req} day(s) of ${type}.`;
              }
              msgEl.textContent = msg;
            }
            await refreshCompensationOptions();
          }
        } catch (err) {
          console.warn("Failed updating balance preview", err);
        }
      };

      ["change", "input"].forEach((evt) => {
        if (leaveSel)
          leaveSel.addEventListener(evt, refreshCompensationOptions);
        if (startInput)
          startInput.addEventListener(evt, refreshCompensationOptions);
        if (endInput)
          endInput.addEventListener(evt, refreshCompensationOptions);
        if (leaveSel)
          leaveSel.addEventListener(evt, updateBalanceCardAndPreview);
        if (startInput)
          startInput.addEventListener(evt, updateBalanceCardAndPreview);
        if (endInput)
          endInput.addEventListener(evt, updateBalanceCardAndPreview);
      });

      await refreshCompensationOptions();
      await updateBalanceCardAndPreview();
    } catch (err) {
      console.warn("Failed to initialize leave balance checks:", err);
    }
  }, 0);
};

export const handleApplyLeave = async (e) => {
  e.preventDefault();

  console.log("\n" + "=".repeat(60));
  console.log("🚀 LEAVE APPLICATION STARTED");
  console.log("=".repeat(60));

  // Collect values
  const startDate = document.getElementById("startDate").value;
  const endDate = document.getElementById("endDate").value;
  const leaveType = document.getElementById("leaveType").value;
  const compensationType = document.getElementById("compensationType").value;
  const reason = document.getElementById("reason")?.value || "";

  if (!startDate || !endDate)
    return alert("Please select both start and end dates");

  // Always fetch the employee ID from the employees table using the user's name
  let appliedBy = null;
  const userName = state.user?.name;

  if (!userName) {
    return alert("Error: User name not found. Please log in again.");
  }

  console.log("🔍 Fetching employee ID for name:", userName);

  try {
    const allEmployees = await listEmployees(1, 5000);
    console.log("Total employees fetched:", allEmployees.items?.length || 0);

    // First, try to find an exact match
    let match = (allEmployees.items || []).find((e) => {
      const empFullName = `${e.first_name || ""} ${e.last_name || ""} `
        .trim()
        .toLowerCase();
      const searchName = userName.toLowerCase().trim();
      return empFullName === searchName;
    });

    // If no exact match, try to find a match with "karthick" vs "karthik" specifically
    if (!match && userName.toLowerCase().includes("karthik")) {
      match = (allEmployees.items || []).find((e) => {
        const empFullName = `${e.first_name || ""} ${e.last_name || ""} `
          .trim()
          .toLowerCase();
        return empFullName.includes("karthick");
      });
      if (match) {
        console.log("✅ Found match using special case for Karthik/Karthick");
      }
    }

    // If still no match, try more flexible matching
    if (!match) {
      match = (allEmployees.items || []).find((e) => {
        const empFullName = `${e.first_name || ""} ${e.last_name || ""} `
          .trim()
          .toLowerCase();
        const searchName = userName.toLowerCase().trim();

        // Remove all non-alphanumeric characters for comparison
        const normalizedEmpName = empFullName.replace(/[^a-z0-9]/g, "");
        const normalizedSearchName = searchName.replace(/[^a-z0-9]/g, "");

        // Check if names are similar enough (first name matches)
        const empFirstName = (e.first_name || "").toLowerCase().trim();
        const searchFirstName = searchName.split(" ")[0];

        const nameMatches =
          // Check if normalized names match
          normalizedEmpName === normalizedSearchName ||
          // Check if one contains the other
          normalizedEmpName.includes(normalizedSearchName) ||
          normalizedSearchName.includes(normalizedEmpName) ||
          // Check if first names are similar (allowing for spelling variations)
          empFirstName.replace("ck", "k") === searchFirstName ||
          searchFirstName.replace("ck", "k") === empFirstName;

        console.log(`Comparing: "${empFullName}" with "${searchName}"`, {
          nameMatches,
        });

        return nameMatches;
      });
    }

    if (match && match.employee_id) {
      appliedBy = match.employee_id.trim().toUpperCase();
      // Update state with correct employee ID
      state.user.id = appliedBy;
      try {
        localStorage.setItem(
          "auth",
          JSON.stringify({ authenticated: true, user: state.user })
        );
      } catch { }
      console.log(`✅ Found employee ID: ${appliedBy} `);
    } else {
      console.error("❌ No employee record found for name:", userName);
      console.log(
        "Available employees:",
        allEmployees.items?.map((e) => ({
          id: e.employee_id,
          name: `${e.first_name || ""} ${e.last_name || ""} `.trim(),
        }))
      );
      return alert(
        "Error: Could not find your employee record. Please contact administrator."
      );
    }
  } catch (err) {
    console.error("❌ Failed to fetch employee data:", err);
    return alert("Error: Failed to verify employee information.");
  }

  const leavePayload = {
    leave_type: leaveType,
    start_date: startDate,
    end_date: endDate,
    employee_id: appliedBy,
    applied_by: appliedBy,
    paid_unpaid: compensationType,
    status: "Pending",
    reason,
  };

  console.log("📤 Payload prepared:", leavePayload);

  try {
    // Client-side guard: if Paid, ensure sufficient balance for non CL/SL types
    if (String(compensationType).toLowerCase() === "paid") {
      try {
        const requestedDays = calculateLeaveDays(startDate, endDate);

        if (leaveType === "Casual Leave" || leaveType === "Sick Leave") {
          // For CL/SL, backend will auto-split into Paid + Unpaid based on available balance.
        } else {
          const availableBalance = await fetchLeaveBalance(
            appliedBy,
            leaveType
          );
          if (availableBalance < requestedDays) {
            return alert(
              `Insufficient ${leaveType} balance.Available: ${availableBalance}, Requested: ${requestedDays}. Please choose Unpaid or adjust dates.`
            );
          }
        }
      } catch (err) {
        console.error("Error during leave balance validation:", err);
        return alert(
          "Could not validate your leave balance. Please try again."
        );
      }
    }

    const backendURL = "http://localhost:5000/api/apply-leave";
    console.log("🌐 Sending POST request to:", backendURL);

    const response = await fetch(backendURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(leavePayload),
    });

    const contentType = response.headers.get("content-type") || "";
    const responseText = await response.text();
    console.log("📄 Raw response:", responseText);

    let result = null;
    if (responseText && contentType.includes("application/json")) {
      try {
        result = JSON.parse(responseText);
      } catch (parseErr) {
        console.warn("⚠️ Failed to parse JSON response:", parseErr);
      }
    }

    if (response.ok) {
      console.log("✅ Leave application SUCCESSFUL!");

      // If modal is still open, update live balance card with server-returned balances before closing
      try {
        const clEl = document.getElementById("bal-cl");
        const slEl = document.getElementById("bal-sl");
        const coEl = document.getElementById("bal-co");
        const totEl = document.getElementById("bal-total");
        if (result && result.balances) {
          if (clEl && typeof result.balances["Casual Leave"] !== "undefined")
            clEl.textContent = String(result.balances["Casual Leave"]);
          if (slEl && typeof result.balances["Sick Leave"] !== "undefined")
            slEl.textContent = String(result.balances["Sick Leave"]);
          if (coEl && typeof result.balances["Comp Off"] !== "undefined")
            coEl.textContent = String(result.balances["Comp Off"]);
          if (totEl && typeof result.balances["Total"] !== "undefined")
            totEl.textContent = String(result.balances["Total"]);
        }
      } catch { }

      // Send notification to admin
      try {
        await notifyAdminLeaveApplication(
          result?.leave_id || "N/A",
          appliedBy, // Use the resolved employee ID
          leaveType,
          startDate,
          endDate
        );
      } catch (notifErr) {
        console.warn("⚠️ Failed to send notification to admin:", notifErr);
      }

      // Show success toast notification
      const requestedDays = calculateLeaveDays(startDate, endDate);
      showLeaveApplicationToast(leaveType, requestedDays);

      // Now close modal
      closeModal();

      // Clear the cached leaves to force a fresh fetch
      state.leaves = [];

      // Wait for Dataverse to process and index the new record
      console.log("⏳ Waiting for Dataverse to process the new record...");
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Fetch fresh data from Dataverse to update the UI - force refresh
      console.log(
        "🔄 Refreshing leave history after successful application..."
      );
      await renderLeaveTrackerPage(1, true);

      // If user is on My Attendance page, refresh it to reflect leave status
      if (window.location.hash === "#/attendance-my") {
        await renderMyAttendancePage();
      }
      alert(
        result?.message ||
        "✅ Leave applied successfully and stored in Dataverse!"
      );
    } else {
      const msg =
        result?.error ||
        result?.message ||
        responseText ||
        `HTTP ${response.status} ${response.statusText} `;
      console.error("❌ Server Error:", msg);
      alert("❌ Error applying leave:\n" + msg);
    }
  } catch (err) {
    console.error("❌ Network/Fetch Error:", err);
    alert("❌ Failed to apply leave.\n" + err.message);
  }

  console.log("🏁 LEAVE APPLICATION PROCESS ENDED");
};
