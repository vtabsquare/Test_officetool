// leaveSettings.js - Leave Settings page for admin to manage leave allocation types
import { state } from '../state.js';
import { getPageContentHTML } from '../utils.js';
import { listEmployees } from '../features/employeeApi.js';
import { renderModal, closeModal } from '../components/modal.js';
import { isAdminUser } from '../utils/accessControl.js';

const API_BASE = 'http://localhost:5000/api';

// Leave allocation types configuration (defaults)
const LEAVE_ALLOCATION_TYPES = [
    {
        type: 'Type 1',
        experience: 3, // 3+ years
        casualLeave: 6,
        sickLeave: 6,
        totalQuota: 12
    },
    {
        type: 'Type 2',
        experience: 2, // 2+ years
        casualLeave: 4,
        sickLeave: 4,
        totalQuota: 8
    },
    {
        type: 'Type 3',
        experience: 1, // 1+ years
        casualLeave: 3,
        sickLeave: 3,
        totalQuota: 6
    }
];

// Live allocation types state (can be customized via UI and saved to localStorage)
let allocationTypes = [...LEAVE_ALLOCATION_TYPES];

const ALLOCATION_TYPES_STORAGE_KEY = 'leave_allocation_types_v1';

try {
    const raw = localStorage.getItem(ALLOCATION_TYPES_STORAGE_KEY);
    if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) {
            allocationTypes = parsed.map(t => ({ ...t }));
        }
    }
} catch {
    allocationTypes = [...LEAVE_ALLOCATION_TYPES];
}

// Parse date from various formats (Dataverse can return different formats)
const parseDate = (dateString) => {
    if (!dateString) return null;

    // Handle different date formats from Dataverse
    let date = null;

    try {
        // Try direct parsing first
        date = new Date(dateString);
        if (!isNaN(date.getTime())) {
            return date;
        }

        // Try parsing ISO date format (YYYY-MM-DD)
        if (typeof dateString === 'string' && dateString.includes('-')) {
            const parts = dateString.split('T')[0]; // Remove time part if present
            date = new Date(parts);
            if (!isNaN(date.getTime())) {
                return date;
            }
        }

        // Try parsing DD/MM/YYYY format
        if (typeof dateString === 'string' && dateString.includes('/')) {
            const parts = dateString.split('/');
            if (parts.length === 3) {
                // Assume DD/MM/YYYY format
                const day = parseInt(parts[0]);
                const month = parseInt(parts[1]) - 1; // Month is 0-indexed
                const year = parseInt(parts[2]);
                date = new Date(year, month, day);
                if (!isNaN(date.getTime())) {
                    return date;
                }
            }
        }

        console.warn(`Could not parse date: ${dateString}`);
        return null;
    } catch (error) {
        console.error(`Error parsing date: ${dateString}`, error);
        return null;
    }
};

// Calculate employee experience in years from date of joining
const calculateExperience = (dateOfJoining) => {
    if (!dateOfJoining) return 0;

    try {
        const joinDate = parseDate(dateOfJoining);

        // Check if date is valid
        if (!joinDate || isNaN(joinDate.getTime())) {
            console.warn(`Invalid date of joining: ${dateOfJoining}`);
            return 0;
        }

        const currentDate = new Date();

        // Ensure join date is not in the future
        if (joinDate > currentDate) {
            console.warn(`Date of joining is in the future: ${dateOfJoining}`);
            return 0;
        }

        const diffInMs = currentDate - joinDate;
        const diffInYears = diffInMs / (1000 * 60 * 60 * 24 * 365.25);

        return Math.max(0, Math.floor(diffInYears));
    } catch (error) {
        console.error(`Error calculating experience for date: ${dateOfJoining}`, error);
        return 0;
    }
};

// Determine allocation type based on experience using current configuration
const getAllocationType = (experienceYears) => {
    const types = [...allocationTypes].sort((a, b) => (b.experience || 0) - (a.experience || 0));
    for (const t of types) {
        const threshold = Number(t.experience || 0);
        if (experienceYears >= threshold) return t;
    }
    return types[types.length - 1] || allocationTypes[allocationTypes.length - 1] || LEAVE_ALLOCATION_TYPES[LEAVE_ALLOCATION_TYPES.length - 1];
};

// Format date for display
const formatDate = (dateString) => {
    if (!dateString) return 'N/A';

    try {
        const date = parseDate(dateString);
        if (!date || isNaN(date.getTime())) {
            // Show raw value for debugging
            console.warn(`Could not format date, showing raw value: ${dateString}`);
            return `Raw: ${dateString}`;
        }

        return date.toLocaleDateString('en-GB', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });
    } catch (error) {
        console.error(`Error formatting date: ${dateString}`, error);
        return `Error: ${dateString}`;
    }
};

// Render allocation types table (with edit actions)
const renderAllocationTypesTable = () => {
    const rows = allocationTypes.map((type, index) => `
        <tr>
            <td><strong>${type.type}</strong></td>
            <td>${type.experience}+</td>
            <td>${type.casualLeave}</td>
            <td>${type.sickLeave}</td>
            <td><strong>${type.totalQuota}</strong></td>
            <td>
                <button type="button" class="icon-btn" title="Edit allocation type" onclick="window.handleEditAllocationType(${index}, this)">
                    <i class="fa-solid fa-pen-to-square"></i>
                </button>
            </td>
        </tr>
    `).join('');

    return `
        <div class="card">
            <h3><i class="fa-solid fa-table"></i> Leave Allocation Types</h3>
            <p class="allocation-description">Configure leave quotas based on employee experience.</p>
            <div class="table-container">
                <table class="table">
                    <thead>
                        <tr>
                            <th>Allocation Type</th>
                            <th>Experience (Years)</th>
                            <th>Casual Leave</th>
                            <th>Sick Leave</th>
                            <th>Total Quota</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows}
                    </tbody>
                </table>
            </div>
        </div>
    `;
};

// Global Edit Allocation Type modal (rendered at page root, not inside the table card)
const renderEditAllocationTypeModal = () => {
    return '';
};

// Open edit modal for a specific allocation type
// "triggerEl" is the button that was clicked; we use its position to anchor the popup nearby.
const handleEditAllocationType = (index, triggerEl) => {
    const idx = Number(index);
    if (Number.isNaN(idx) || idx < 0 || idx >= allocationTypes.length) return;
    const current = allocationTypes[idx];

    const total = Number(current.totalQuota || (current.casualLeave || 0) + (current.sickLeave || 0));

    const formHTML = `
        <div class="modal-form modern-form team-modal">
            <div class="form-section">
                <div class="form-section-header">
                    <div>
                        <p class="form-eyebrow">LEAVE SETTINGS</p>
                        <h3>Edit allocation type</h3>
                    </div>
                </div>
                
                <input type="hidden" id="edit-type-index" value="${idx}" />
                
                <div class="form-field">
                    <label class="form-label" for="edit-type-name">Allocation Type</label>
                    <input id="edit-type-name" class="input-control" type="text" required value="${current.type || ''}" />
                </div>
                
                <div class="form-field">
                    <label class="form-label" for="edit-type-experience">Experience (Years)</label>
                    <input id="edit-type-experience" class="input-control" type="number" min="0" step="1" required value="${Number(current.experience || 0)}" />
                </div>
                
                <div class="form-field">
                    <label class="form-label">Leave Quotas</label>
                    <div class="form-grid two-col">
                        <div class="leave-type-card">
                            <div class="leave-type-label">Casual Leave</div>
                            <input id="edit-type-casual" type="number" min="0" step="1" class="input-control center-input" required value="${Number(current.casualLeave || 0)}" />
                        </div>
                        <div class="leave-type-card">
                            <div class="leave-type-label">Sick Leave</div>
                            <input id="edit-type-sick" type="number" min="0" step="1" class="input-control center-input" required value="${Number(current.sickLeave || 0)}" />
                        </div>
                    </div>
                </div>
                
                <div class="form-field">
                    <label class="form-label">Total Quota</label>
                    <p id="edit-type-total" class="total-quota-display">${total}</p>
                </div>
            </div>
        </div>
    `;

    renderModal('Edit Allocation Type', formHTML, [
        {
            id: 'cancel-edit-type-btn',
            text: 'Cancel',
            className: 'btn-secondary',
            type: 'button',
        },
        {
            id: 'save-edit-type-btn',
            text: 'Save Changes',
            className: 'btn-primary',
            type: 'button',
        },
    ]);

    const casualInput = document.getElementById('edit-type-casual');
    const sickInput = document.getElementById('edit-type-sick');
    const totalEl = document.getElementById('edit-type-total');

    const updateTotal = () => {
        const cl = Math.max(0, Number(casualInput?.value || 0));
        const sl = Math.max(0, Number(sickInput?.value || 0));
        if (totalEl) {
            totalEl.textContent = String(cl + sl);
        }
    };

    if (casualInput && sickInput && totalEl) {
        casualInput.addEventListener('input', updateTotal);
        sickInput.addEventListener('input', updateTotal);
    }

    const saveButton = document.getElementById('save-edit-type-btn');
    const cancelButton = document.getElementById('cancel-edit-type-btn');

    if (saveButton) {
        saveButton.onclick = () => {
            saveEditedAllocationType();
        };
    }

    if (cancelButton) {
        cancelButton.onclick = () => {
            closeEditTypeModal();
        };
    }
};

const closeEditTypeModal = () => {
    closeModal();
};

const saveEditedAllocationType = () => {
    const idx = Number(document.getElementById('edit-type-index').value);
    if (Number.isNaN(idx) || idx < 0 || idx >= allocationTypes.length) return;

    const name = document.getElementById('edit-type-name').value.trim();
    const experience = Math.max(0, Number(document.getElementById('edit-type-experience').value || 0));
    const casualLeave = Math.max(0, Number(document.getElementById('edit-type-casual').value || 0));
    const sickLeave = Math.max(0, Number(document.getElementById('edit-type-sick').value || 0));
    const totalQuota = casualLeave + sickLeave;

    allocationTypes[idx] = {
        type: name || allocationTypes[idx].type,
        experience,
        casualLeave,
        sickLeave,
        totalQuota,
    };

    try {
        localStorage.setItem(ALLOCATION_TYPES_STORAGE_KEY, JSON.stringify(allocationTypes));
    } catch { }

    closeEditTypeModal();
    // Re-render page so both tables use updated configuration
    renderLeaveSettingsPage();
};

// Handle edit allocation
const handleEditAllocation = async (employeeId, name, currentCL, currentSL, allocationType) => {
    console.log('✏️ Editing allocation for:', employeeId);

    // Determine current allocation type based on CL and SL values
    let currentType = 'Type 3'; // Default
    if (currentCL === 6 && currentSL === 6) {
        currentType = 'Type 1';
    } else if (currentCL === 4 && currentSL === 4) {
        currentType = 'Type 2';
    } else if (currentCL === 3 && currentSL === 3) {
        currentType = 'Type 3';
    }

    const total = currentCL + currentSL;

    const formHTML = `
        <div class="modal-form modern-form leave-form">
            <div class="form-section">
                <div class="form-section-header">
                    <div>
                        <p class="form-eyebrow">LEAVE SETTINGS</p>
                        <h3>Edit leave allocation</h3>
                    </div>
                </div>
                <input type="hidden" id="edit-employee-id" value="${employeeId}" />
                <div class="form-grid-2-col">
                    <div class="form-field">
                        <label class="form-label" for="edit-employee-name">Employee</label>
                        <input type="text" id="edit-employee-name" class="input-control" value="${name || ''}" readonly />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="edit-allocation-type">Allocation Type</label>
                        <select id="edit-allocation-type" class="input-control" required onchange="window.updateAllocationTypeValues()">
                            <option value="Type 1" ${currentType === 'Type 1' ? 'selected' : ''}>Type 1 (3+ years) - CL: 6, SL: 6</option>
                            <option value="Type 2" ${currentType === 'Type 2' ? 'selected' : ''}>Type 2 (2+ years) - CL: 4, SL: 4</option>
                            <option value="Type 3" ${currentType === 'Type 3' ? 'selected' : ''}>Type 3 (<2 years) - CL: 3, SL: 3</option>
                        </select>
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="edit-casual-leave-display">Casual Leave</label>
                        <input type="number" id="edit-casual-leave-display" class="input-control" value="${currentCL}" readonly />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="edit-sick-leave-display">Sick Leave</label>
                        <input type="number" id="edit-sick-leave-display" class="input-control" value="${currentSL}" readonly />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="edit-total-quota">Total Quota</label>
                        <input type="number" id="edit-total-quota" class="input-control" value="${total}" readonly />
                    </div>
                </div>
            </div>
        </div>
    `;

    renderModal('Edit Leave Allocation', formHTML, [
        {
            id: 'cancel-edit-allocation-btn',
            text: 'Cancel',
            className: 'btn-secondary',
            type: 'button',
        },
        {
            id: 'save-edit-allocation-btn',
            text: 'Save Changes',
            className: 'btn-primary',
            type: 'button',
        },
    ]);

    const saveButton = document.getElementById('save-edit-allocation-btn');
    const cancelButton = document.getElementById('cancel-edit-allocation-btn');

    if (saveButton) {
        saveButton.onclick = () => {
            saveEditedAllocation();
        };
    }

    if (cancelButton) {
        cancelButton.onclick = () => {
            closeEditModal();
        };
    }
};

// Update leave values when allocation type changes
const updateAllocationTypeValues = () => {
    const typeSelect = document.getElementById('edit-allocation-type');
    const selectedType = typeSelect.value;

    let cl = 3, sl = 3; // Default Type 3

    if (selectedType === 'Type 1') {
        cl = 6;
        sl = 6;
    } else if (selectedType === 'Type 2') {
        cl = 4;
        sl = 4;
    } else if (selectedType === 'Type 3') {
        cl = 3;
        sl = 3;
    }

    const casualInput2 = document.getElementById('edit-casual-leave-display');
    const sickInput2 = document.getElementById('edit-sick-leave-display');
    const totalInput2 = document.getElementById('edit-total-quota');
    if (casualInput2) casualInput2.value = cl;
    if (sickInput2) sickInput2.value = sl;
    if (totalInput2) totalInput2.value = cl + sl;
};

// Save edited allocation
const saveEditedAllocation = async () => {
    const employeeId = document.getElementById('edit-employee-id').value;
    const selectedType = document.getElementById('edit-allocation-type').value;

    // Get CL and SL based on selected type
    let casualLeave = 3, sickLeave = 3; // Default Type 3

    if (selectedType === 'Type 1') {
        casualLeave = 6;
        sickLeave = 6;
    } else if (selectedType === 'Type 2') {
        casualLeave = 4;
        sickLeave = 4;
    } else if (selectedType === 'Type 3') {
        casualLeave = 3;
        sickLeave = 3;
    }

    try {
        const response = await fetch(`${API_BASE}/employee-leave-allocation/${employeeId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                casualLeave,
                sickLeave
            })
        });

        const result = await response.json();

        if (result.success) {
            alert(`✅ Leave allocation updated successfully for ${employeeId}`);
            closeEditModal();
            // Reload the page to show updated data
            renderLeaveSettingsPage();
        } else {
            alert(`❌ Error: ${result.error || 'Failed to update leave allocation'}`);
        }
    } catch (error) {
        console.error('Error updating leave allocation:', error);
        alert('❌ Error updating leave allocation. Please try again.');
    }
};

// Close edit modal
const closeEditModal = () => {
    closeModal();
};

// Render employee allocation table
const renderEmployeeAllocationTable = async () => {
    try {
        const allEmployees = await listEmployees(1, 5000);
        const employees = allEmployees.items || [];

        if (employees.length === 0) {
            return `
                <div class="card">
                    <h3><i class="fa-solid fa-users"></i> Employee Leave Allocations</h3>
                    <p class="placeholder-text">No employees found.</p>
                </div>
            `;
        }

        // Calculate experience and allocation for each employee
        console.log('📊 Processing employees for leave allocation:', employees.length);
        console.log('🔍 Raw employee data sample:', employees.slice(0, 2));

        const employeeAllocations = employees.map(emp => {
            // Use 'doj' field from Dataverse employee table
            const dateOfJoining = emp.doj || emp.date_of_joining;
            const experience = calculateExperience(dateOfJoining);
            const allocation = getAllocationType(experience);

            // Debug logging for first few employees
            if (employees.indexOf(emp) < 3) {
                console.log(`👤 Employee ${emp.employee_id}:`, {
                    doj: emp.doj,
                    dojType: typeof emp.doj,
                    date_of_joining: emp.date_of_joining,
                    dateOfJoiningType: typeof emp.date_of_joining,
                    finalDOJ: dateOfJoining,
                    finalDOJType: typeof dateOfJoining,
                    parsedDate: parseDate(dateOfJoining),
                    experience,
                    allocationType: allocation.type
                });
            }

            return {
                employeeId: emp.employee_id,
                name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
                dateOfJoining: dateOfJoining,
                experience,
                allocationType: allocation.type,
                casualLeave: allocation.casualLeave,
                sickLeave: allocation.sickLeave,
                totalQuota: allocation.totalQuota
            };
        });

        // Sort by employee ID
        employeeAllocations.sort((a, b) => (a.employeeId || '').localeCompare(b.employeeId || ''));

        return `
            <div class="card">
                <h3><i class="fa-solid fa-users"></i> Employee Leave Allocations</h3>
                <p class="allocation-description">Current leave allocations for all employees based on their experience.</p>
                <div class="table-container">
                    <table class="table">
                        <thead>
                            <tr>
                                <th>Employee ID</th>
                                <th>Employee Name</th>
                                <th>Date of Joining</th>
                                <th>Experience</th>
                                <th>Allocation Type</th>
                                <th>Casual Leave</th>
                                <th>Sick Leave</th>
                                <th>Total Quota</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${employeeAllocations.map(emp => `
                                <tr>
                                    <td><strong>${emp.employeeId}</strong></td>
                                    <td>${emp.name}</td>
                                    <td>${formatDate(emp.dateOfJoining)}</td>
                                    <td>${emp.experience} year${emp.experience !== 1 ? 's' : ''}</td>
                                    <td><span class="status-badge ${emp.allocationType.toLowerCase().replace(' ', '-')}">${emp.allocationType}</span></td>
                                    <td>${emp.casualLeave}</td>
                                    <td>${emp.sickLeave}</td>
                                    <td><strong>${emp.totalQuota}</strong></td>
                                    <td>
                                        <button class="btn-icon" onclick="window.handleEditAllocation('${emp.employeeId}', '${emp.name}', ${emp.casualLeave}, ${emp.sickLeave}, '${emp.allocationType}')" title="Edit Allocation">
                                            <i class="fa-solid fa-pen-to-square"></i>
                                        </button>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
                <div class="allocation-note">
                    <strong>Note:</strong> Leave allocations are automatically calculated based on employee experience.
                    Experience is calculated from the date of joining to the current date. You can manually override allocations using the Edit button.
                </div>
            </div>
        `;

    } catch (error) {
        console.error('❌ Error loading employee allocations:', error);
        return `
            <div class="card">
                <h3><i class="fa-solid fa-users"></i> Employee Leave Allocations</h3>
                <p class="placeholder-text error-message">Error loading employee data.</p>
            </div>
        `;
    }
};

// Render Leave Settings page (Admin Only)
export const renderLeaveSettingsPage = async () => {
    console.log('⚙️ Rendering Leave Settings Page...');

    // Check if user is admin
    if (!isAdminUser()) {
        const content = `
            <div class="card">
                <div class="access-denied-content">
                    <i class="fa-solid fa-lock fa-3x error-icon"></i>
                    <h3 class="error-heading">Access Denied</h3>
                    <p>Leave Settings is only accessible to administrators.</p>
                    <p class="access-denied-note">Please contact your administrator if you need access.</p>
                </div>
            </div>
        `;
        document.getElementById('app-content').innerHTML = getPageContentHTML('Leave Settings', content);
        return;
    }

    // Show loading state
    const loadingContent = `
        ${renderAllocationTypesTable()}
        <div class="card">
            <h3><i class="fa-solid fa-users"></i> Employee Leave Allocations</h3>
            <p class="placeholder-text">⏳ Loading employee allocations...</p>
        </div>
        ${renderEditAllocationTypeModal()}
    `;

    document.getElementById('app-content').innerHTML = getPageContentHTML('Leave Settings', loadingContent);

    // Load employee allocation table
    try {
        const employeeTable = await renderEmployeeAllocationTable();
        const finalContent = `
            ${renderAllocationTypesTable()}
            ${employeeTable}
            ${renderEditAllocationTypeModal()}
        `;

        document.getElementById('app-content').innerHTML = getPageContentHTML('Leave Settings', finalContent);
        console.log('✅ Leave Settings page loaded successfully');

    } catch (error) {
        console.error('❌ Error loading leave settings:', error);
        const errorContent = `
            ${renderAllocationTypesTable()}
            <div class="card">
                <h3><i class="fa-solid fa-users"></i> Employee Leave Allocations</h3>
                <p class="placeholder-text error-message">Error loading employee data.</p>
            </div>
            ${renderEditAllocationTypeModal()}
        `;
        document.getElementById('app-content').innerHTML = getPageContentHTML('Leave Settings', errorContent);
    }
};

// Export functions to window for onclick handlers
if (typeof window !== 'undefined') {
    window.handleEditAllocation = handleEditAllocation;
    window.closeEditModal = closeEditModal;
    window.saveEditedAllocation = saveEditedAllocation;
    window.updateAllocationTypeValues = updateAllocationTypeValues;
    window.handleEditAllocationType = handleEditAllocationType;
    window.closeEditTypeModal = closeEditTypeModal;
    window.saveEditedAllocationType = saveEditedAllocationType;
}

// Export dummy function for compatibility
export const handleEditLeave = async (e) => {
    console.log('Edit leave function called - not implemented in new leave settings');
};
