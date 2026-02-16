import { getPageContentHTML } from "../utils.js";
import { state } from "../state.js";
import { renderModal, closeModal } from "../components/modal.js";
import { API_BASE_URL } from '../config.js';

const API_BASE = `${API_BASE_URL}/api/assets`;

// -------------------- FETCH ASSETS --------------------
export const fetchAssets = async () => {
  try {
    const res = await fetch(API_BASE);
    const data = await res.json();
    state.assets = data.map((a) => ({
      id: a.crc6f_assetid,
      name: a.crc6f_assetname,
      serialNo: a.crc6f_serialnumber,
      category: a.crc6f_assetcategory,
      location: a.crc6f_location,
      status: a.crc6f_assetstatus,
      assignedTo: a.crc6f_assignedto,
      employeeId: a.crc6f_employeeid,
      assignedOn: a.crc6f_assignedon,
    }));
  } catch (err) {
    console.error("Error fetching assets:", err);
    state.assets = [];
  }
};

// -------------------- RENDER PAGE --------------------
export const renderAssetsPage = async () => {
  try {
    // Fetch latest assets from Dataverse
    await fetchAssets();

    const controls = `<button id="add-asset-btn" class="btn btn-primary"><i class="fa-solid fa-plus"></i> ADD NEW ASSET</button>`;
    const statusClass = (status) => status.toLowerCase().replace(" ", "");

    const tableRows = state.assets
      .map(
        (asset) => `
        <tr>
            <td>${asset.id}</td>
            <td>${asset.name}</td>
            <td>${asset.serialNo}</td>
            <td>${asset.category}</td>
            <td>${asset.assignedTo || "-"}</td>
            <td>${asset.employeeId || "-"}</td>
            <td>${asset.assignedOn || "-"}</td>
            <td>${asset.location}</td>
            <td><span class="status-badge ${statusClass(asset.status)}">${asset.status
          }</span></td>
            <td class="actions-cell">
                <button class="icon-btn action-btn edit edit-asset-btn" data-id="${asset.id
          }"><i class="fa-solid fa-pen-to-square"></i></button>
                <button class="icon-btn action-btn delete delete-asset-btn" data-id="${asset.id
          }"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>
    `
      )
      .join("");

    const content = `
        <div class="card">
            <div class="table-container">
                <table class="table">
                    <thead>
                        <tr>
                            <th>Asset ID</th>
                            <th>Asset Name</th>
                            <th>Serial No</th>
                            <th>Category</th>
                            <th>Assigned To</th>
                            <th>Employee ID</th>
                            <th>Assigned On</th>
                            <th>Location</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRows ||
      `<tr><td colspan="10">No assets found. Click ADD NEW ASSET to add one.</td></tr>`
      }
                    </tbody>
                </table>
            </div>
        </div>
    `;

    document.getElementById("app-content").innerHTML = getPageContentHTML(
      "Assets",
      content,
      controls
    );

    // -------------------- EVENT LISTENERS --------------------
    document
      .getElementById("add-asset-btn")
      .addEventListener("click", () => showAssetModal());

    document.querySelectorAll(".edit-asset-btn").forEach((btn) => {
      btn.addEventListener("click", () => showAssetModal(btn.dataset.id));
    });

    document.querySelectorAll(".delete-asset-btn").forEach((btn) => {
      btn.addEventListener("click", () =>
        showDeleteConfirmModal(btn.dataset.id)
      );
    });
  } catch (err) {
    console.error("Error rendering assets page:", err);
    document.getElementById(
      "app-content"
    ).innerHTML = `<p class="error">Failed to load assets.</p>`;
  }
};

// -------------------- SHOW MODAL --------------------
export const showAssetModal = (assetId) => {
  const isEditMode = Boolean(assetId);
  const asset = isEditMode ? state.assets.find((a) => a.id === assetId) : null;

  const formHTML = `
      <div class="modal-form modern-form asset-form">
          <!-- Section 1: Asset Information -->
          <div class="form-section">
              <div class="form-section-header">
                  <div>
                      <p class="form-eyebrow">Asset Details</p>
                      <h3>Basic Information</h3>
                  </div>
                  <p class="form-section-copy">Enter the core details for this asset.</p>
              </div>
              <div class="form-grid two-col">
                  <div class="form-field">
                      <label class="form-label" for="assetName">Asset Name</label>
                      <input class="input-control" type="text" id="assetName" required value="${asset?.name || ""}" placeholder="Dell Laptop">
                  </div>
                  <div class="form-field">
                      <label class="form-label" for="serialNo">Serial Number</label>
                      <input class="input-control" type="text" id="serialNo" required value="${asset?.serialNo || ""}" placeholder="SN123456789">
                  </div>
                  <div class="form-field">
                      <label class="form-label" for="assetCategory">Category</label>
                      <select class="input-control" id="assetCategory" required>
                          <option value="" disabled ${!asset?.category ? 'selected' : ''}>Select category</option>
                          <option ${asset?.category === "Laptop" ? "selected" : ""}>Laptop</option>
                          <option ${asset?.category === "Monitor" ? "selected" : ""}>Monitor</option>
                          <option ${asset?.category === "Charger" ? "selected" : ""}>Charger</option>
                          <option ${asset?.category === "Keyboard" ? "selected" : ""}>Keyboard</option>
                          <option ${asset?.category === "Headset" ? "selected" : ""}>Headset</option>
                          <option ${asset?.category === "Accessory" ? "selected" : ""}>Accessory</option>
                      </select>
                  </div>
                  <div class="form-field">
                      <label class="form-label" for="assetLocation">Location</label>
                      <input class="input-control" type="text" id="assetLocation" required value="${asset?.location || ""}" placeholder="Office Building A">
                  </div>
              </div>
          </div>
          
          <!-- Section 2: Assignment Details -->
          <div class="form-section">
              <div class="form-section-header">
                  <div>
                      <p class="form-eyebrow">Assignment & Status</p>
                      <h3>Assignment Information</h3>
                  </div>
              </div>
              <div class="form-grid two-col">
                  <div class="form-field">
                      <label class="form-label" for="assetStatus">Status</label>
                      <select class="input-control" id="assetStatus">
                          <option ${asset?.status === "In Use" ? "selected" : ""}>In Use</option>
                          <option ${asset?.status === "Not Use" ? "selected" : ""}>Not Use</option>
                          <option ${asset?.status === "Repair" ? "selected" : ""}>Repair</option>
                      </select>
                  </div>
                  <div class="form-field">
                      <label class="form-label" for="assignedOn">Assigned On</label>
                      <input class="input-control" type="date" id="assignedOn" value="${asset?.assignedOn || ""}">
                  </div>
                  <div class="form-field">
                      <label class="form-label" for="assignedTo">Assigned To</label>
                      <input class="input-control" type="text" id="assignedTo" value="${asset?.assignedTo || ""}" placeholder="John Doe">
                     <p class="helper-text">Employee name who is currently using this asset.</p>
                  </div>
                  <div class="form-field">
                      <label class="form-label" for="employeeId">Employee ID</label>
                      <input class="input-control" type="text" id="employeeId" value="${asset?.employeeId || ""}" placeholder="EMP-001">
                  </div>
              </div>
          </div>
      </div>
  `;

  renderModal(isEditMode ? "Edit Asset" : "Add New Asset", formHTML, [
    {
      id: "cancel-asset-btn",
      text: "Cancel",
      className: "btn-secondary",
      type: "button",
    },
    {
      id: "save-asset-btn",
      text: isEditMode ? "Update" : "Save",
      className: "btn-primary",
      type: "button",
    },
  ]);

  // Attach listener
  document.getElementById("save-asset-btn").onclick = async () => {
    try {
      await handleSaveAsset(assetId);
    } catch (err) {
      console.error(err);
      alert("Error saving asset: " + err.message);
    }
  };
  document.getElementById("cancel-asset-btn").onclick = closeModal;
};

export const handleSaveAsset = async (assetId) => {
  const isEditMode = Boolean(assetId);

  const category = document.getElementById("assetCategory").value;
  const assetData = {
    crc6f_assetname: document.getElementById("assetName").value,
    crc6f_serialnumber: document.getElementById("serialNo").value,
    crc6f_assetcategory: category,
    crc6f_location: document.getElementById("assetLocation").value,
    crc6f_assetstatus: document.getElementById("assetStatus").value,
    crc6f_assignedto: document.getElementById("assignedTo").value,
    crc6f_employeeid: document.getElementById("employeeId").value,
    crc6f_assignedon: document.getElementById("assignedOn").value,
  };

  if (!isEditMode) {
    // New asset: generate ID
    const prefixMap = {
      Laptop: "LP",
      Monitor: "MO",
      Charger: "CH",
      Keyboard: "KB",
      Headset: "HS",
      Accessory: "AC",
    };
    const prefix = prefixMap[category] || "GEN";
    const count =
      state.assets.filter((a) => a.category === category).length + 1;
    assetData.crc6f_assetid = `${prefix}-${count}`;
  } else {
    // Editing existing asset
    const oldAsset = state.assets.find((a) => a.id === assetId);
    if (!oldAsset) throw new Error("Asset not found for update");

    // If category changed, regenerate asset ID
    if (oldAsset.category !== category) {
      const prefixMap = {
        Laptop: "LP",
        Monitor: "MO",
        Charger: "CH",
        Keyboard: "KB",
        Headset: "HS",
        Accessory: "AC",
      };
      const prefix = prefixMap[category] || "GEN";
      const count =
        state.assets.filter((a) => a.category === category).length + 1;
      assetData.crc6f_assetid = `${prefix}-${count}`;
    } else {
      assetData.crc6f_assetid = assetId; // keep old ID if category didn't change
    }
  }

  try {
    let res;
    if (isEditMode) {
      res = await fetch(`${API_BASE}/update/${assetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(assetData),
      });
    } else {
      res = await fetch(API_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(assetData),
      });
    }

    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "Failed to save asset");

    // await fetchAssets(); // refresh UI from Dataverse
    await renderAssetsPage(); // ✅ refresh UI instantly
    closeModal();
  } catch (err) {
    console.error(err);
    alert("Error saving asset: " + err.message);
  }
};

export const showDeleteConfirmModal = (assetId) => {
  const asset = state.assets.find((a) => a.id === assetId);
  if (!asset) return;

  const bodyHTML = `<p>Are you sure you want to delete <strong>${asset.name} (${asset.id})</strong>? This action cannot be undone.</p>`;

  renderModal("Confirm Deletion", bodyHTML, [
    {
      id: "cancel-delete-btn",
      text: "Cancel",
      className: "btn-secondary",
      type: "button",
    },
    {
      id: "confirm-delete-btn",
      text: "Delete",
      className: "btn-danger",
      type: "button",
    },
  ]);

  // ✅ Add working listeners
  document.getElementById("cancel-delete-btn").onclick = closeModal;
  document.getElementById("confirm-delete-btn").onclick = async () => {
    try {
      await handleDeleteAsset(assetId);
      closeModal(); // ✅ also close after successful delete
    } catch (err) {
      console.error(err);
      alert("Error deleting asset: " + err.message);
    }
  };
};

export const handleDeleteAsset = async (assetId) => {
  try {
    const res = await fetch(`${API_BASE}/delete/${assetId}`, {
      method: "DELETE",
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "Failed to delete asset");

    // await fetchAssets();
    await renderAssetsPage(); // ✅ refresh UI instantly
    closeModal();
  } catch (err) {
    console.error(err);
    alert("Error deleting asset: " + err.message);
  }
};
