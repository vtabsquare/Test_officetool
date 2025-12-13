
// export const renderModal = (title, formHTML, submitId, size = 'normal') => {
//     const sizeClass = size === 'large' ? 'modal-large' : '';
//     const modalHTML = `
//         <div class="modal-overlay visible" id="modal-overlay">
//             <div class="modal ${sizeClass}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
//                 <div class="modal-header">
//                     <h2 id="modal-title">${title}</h2>
//                     <button class="modal-close-btn" aria-label="Close dialog">&times;</button>
//                 </div>
//                 <form id="modal-form">
//                     <div class="modal-body">${formHTML}</div>
//                     <div class="modal-footer">
//                         <button type="button" class="btn btn-secondary modal-close-btn">Cancel</button>
//                         <button type="submit" id="${submitId}" class="btn btn-primary">Save</button>
//                     </div>
//                 </form>
//             </div>
//         </div>
//     `;
//     document.getElementById('modal-container').innerHTML = modalHTML;
// };

// export const closeModal = () => {
//     document.getElementById('modal-container').innerHTML = '';
// };


// // -------------------- renderModal --------------------
// export const renderModal = (title, formHTML, submitIdOrButtons, size = 'normal', buttonText = 'Save') => {
//   const sizeClass = size === "large" ? "modal-large" : "";
//   // Ensure container exists
//   const container = document.getElementById("modal-container");
//   if (!container) {
//     console.error("❌ modal-container element not found in DOM.");
//     return;
//   }

//   // If Delete or custom buttons modal (array type)
//   if (Array.isArray(submitIdOrButtons)) {
//     const buttonsHTML = submitIdOrButtons
//       .map(
//         (btn) => `
//           <button
//             id="${btn.id}"
//             type="${btn.type || 'button'}"
//             class="btn ${btn.className || 'btn-primary'}"
//           >
//             ${btn.text}
//           </button>`
//       )
//       .join("");

//     const modalHTML = `
//       <div class="modal-overlay visible" id="modal-overlay">
//         <div class="modal ${sizeClass}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
//           <div class="modal-header">
//             <h2 id="modal-title">${title}</h2>
//             <button class="modal-close-btn" aria-label="Close dialog">&times;</button>
//           </div>
//           <div class="modal-body">${formHTML}</div>
//           <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 10px;">
//             ${buttonsHTML}
//           </div>
//         </div>
//       </div>
//     `;

//     container.innerHTML = modalHTML;
//     return;
//   }

//   // ✅ Normal form modal (Add/Edit)
//   const modalHTML = `
//     <div class="modal-overlay visible" id="modal-overlay">
//       <div class="modal ${sizeClass}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
//         <div class="modal-header">
//           <h2 id="modal-title">${title}</h2>
//           <button class="modal-close-btn" aria-label="Close dialog">&times;</button>
//         </div>
//         <form id="modal-form">
//           <div class="modal-body">${formHTML}</div>
//           <div class="modal-footer" style="display: flex; gap: 12px; justify-content: flex-end;">
//             <button type="button" class="btn btn-secondary modal-close-btn" style="height: 40px; padding: 10px 20px; font-size: 0.95rem; border-radius: 8px; min-width: 100px;">Cancel</button>
//             <button type="submit" id="${submitIdOrButtons}" class="btn btn-primary" style="height: 40px; padding: 10px 20px; font-size: 0.95rem; border-radius: 8px; min-width: 100px;">${buttonText}</button>
//           </div>
//         </form>
//       </div>
//     </div>
//   `;
//   container.innerHTML = modalHTML;
// };

// // -------------------- closeModal --------------------
// export const closeModal = () => {
//   const container = document.getElementById("modal-container");
//   if (container) container.innerHTML = "";
// };

export const renderModal = (
  title,
  formHTML,
  submitIdOrButtons,
  size = "normal",
  buttonText = "Save",
  onRender = null // ⭐ NEW CALLBACK
) => {
  const sizeClass = size === "large" ? "modal-large" : "";
  const container = document.getElementById("modal-container");
  if (!container) {
    console.error("❌ modal-container element not found in DOM.");
    return;
  }

  /* ==========================
     CASE 1: CUSTOM BUTTON MODAL
     ========================== */
  if (Array.isArray(submitIdOrButtons)) {
    const buttonsHTML = submitIdOrButtons
      .map(
        (btn) => `
          <button
            id="${btn.id}"
            type="${btn.type || "button"}"
            class="btn ${btn.className || "btn-primary"}"
          >
            ${btn.text}
          </button>`
      )
      .join("");

    const modalHTML = `
      <div class="modal-overlay visible" id="modal-overlay">
        <div class="modal ${sizeClass}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div class="modal-header">
            <h2 id="modal-title">${title}</h2>
            <button class="modal-close-btn" aria-label="Close dialog">&times;</button>
          </div>
          <div class="modal-body">${formHTML}</div>
          <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 10px;">
            ${buttonsHTML}
          </div>
        </div>
      </div>
    `;

    container.innerHTML = modalHTML;

    // ⭐ CLICK OUTSIDE CLOSES MODAL — SAFE PATCH
    attachOutsideClickClose();
    // ⭐ Execute callback after DOM is ready
    if (typeof onRender === "function") {
      setTimeout(() => onRender(), 10);
    }

    return;
  }

  /* ==========================
     CASE 2: NORMAL FORM MODAL
     ========================== */
  const modalHTML = `
    <div class="modal-overlay visible" id="modal-overlay">
      <div class="modal ${sizeClass}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-header">
          <h2 id="modal-title">${title}</h2>
          <button class="modal-close-btn" aria-label="Close dialog">&times;</button>
        </div>
        <form id="modal-form">
          <div class="modal-body">${formHTML}</div>
          <div class="modal-footer" style="display: flex; gap: 12px; justify-content: flex-end;">
            <button type="button" class="btn btn-secondary modal-close-btn"
              style="height: 40px; padding: 10px 20px; font-size: 0.95rem; border-radius: 8px; min-width: 100px;">
              Cancel
            </button>
            <button type="submit" id="${
              submitIdOrButtons || ""
            }" class="btn btn-primary"

              style="height: 40px; padding: 10px 20px; font-size: 0.95rem; border-radius: 8px; min-width: 100px;">
              ${buttonText}
            </button>
          </div>
        </form>
      </div>
    </div>
  `;

  container.innerHTML = modalHTML;

  // ⭐ CLICK OUTSIDE CLOSES MODAL — SAFE PATCH
  attachOutsideClickClose();
  if (typeof onRender === "function") {
    setTimeout(() => onRender(), 10);
  }
};

/* -------------------- closeModal -------------------- */
export const closeModal = () => {
  const container = document.getElementById("modal-container");
  if (container) container.innerHTML = "";
};

/* ======================================================
   ⭐ SAFE PATCH — WORKS FOR ALL MODALS
   ====================================================== */
function attachOutsideClickClose() {
  const overlay = document.getElementById("modal-overlay");
  const modal = overlay?.querySelector(".modal");
  const closeBtns = overlay?.querySelectorAll(".modal-close-btn");

  if (!overlay || !modal) return;

  // Close when clicking outside modal
  overlay.addEventListener("click", (e) => {
    if (!modal.contains(e.target)) closeModal();
  });

  // Close when clicking X buttons
  closeBtns?.forEach((btn) => {
    btn.addEventListener("click", closeModal);
  });
}
