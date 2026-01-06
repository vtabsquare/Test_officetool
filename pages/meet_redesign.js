// Meet Page - Complete Redesign with Dropdown Selection and Call Notifications
import { state } from '../state.js';
import { getPageContentHTML } from '../utils.js';
import { showToast } from '../components/toast.js';
import { apiBase } from '../config.js';
import { cachedFetch, TTL } from '../features/cache.js';

export const renderMeetPage = async () => {
    const tz = (() => {
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        } catch {
            return 'UTC';
        }
    })();

    const content = `
    <style>
        /* Modern Meet Layout */
        .meet-container {
            max-width: 900px;
            margin: 0 auto;
            padding: 20px;
        }
        .meet-header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            border-radius: 16px;
            margin-bottom: 24px;
            box-shadow: 0 10px 30px rgba(102, 126, 234, 0.3);
        }
        body.dark-theme .meet-header {
            background: linear-gradient(135deg, #4c51bf 0%, #553c9a 100%);
        }
        .meet-header h1 {
            margin: 0 0 8px 0;
            font-size: 28px;
            font-weight: 700;
        }
        .meet-header p {
            margin: 0;
            opacity: 0.9;
            font-size: 15px;
        }
        .meet-card {
            background: white;
            border-radius: 16px;
            padding: 28px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
            margin-bottom: 20px;
        }
        body.dark-theme .meet-card {
            background: rgba(30, 41, 59, 0.9);
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
        }
        .meet-form-group {
            margin-bottom: 20px;
        }
        .meet-form-group label {
            display: block;
            margin-bottom: 8px;
            font-size: 14px;
            font-weight: 600;
            color: #374151;
        }
        body.dark-theme .meet-form-group label {
            color: #e5e7eb;
        }
        .meet-input,
        .meet-textarea {
            width: 100%;
            padding: 12px 16px;
            border: 2px solid #e5e7eb;
            border-radius: 10px;
            font-size: 14px;
            transition: all 0.2s ease;
            background: white;
        }
        .meet-input:focus,
        .meet-textarea:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
        body.dark-theme .meet-input,
        body.dark-theme .meet-textarea {
            background: rgba(30, 41, 59, 0.8);
            border-color: rgba(148, 163, 184, 0.3);
            color: #e5e7eb;
        }
        body.dark-theme .meet-input:focus,
        body.dark-theme .meet-textarea:focus {
            border-color: #818cf8;
        }
        .meet-multiselect {
            position: relative;
        }
        .meet-multiselect-dropdown {
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            max-height: 300px;
            overflow-y: auto;
            background: white;
            border: 2px solid #667eea;
            border-radius: 10px;
            margin-top: 4px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.15);
            z-index: 1000;
            display: none;
        }
        .meet-multiselect-dropdown.active {
            display: block;
        }
        body.dark-theme .meet-multiselect-dropdown {
            background: rgba(30, 41, 59, 0.98);
            border-color: #818cf8;
        }
        .meet-multiselect-option {
            padding: 12px 16px;
            cursor: pointer;
            transition: background 0.15s ease;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .meet-multiselect-option:hover {
            background: #f3f4f6;
        }
        body.dark-theme .meet-multiselect-option:hover {
            background: rgba(55, 65, 81, 0.6);
        }
        .meet-multiselect-option.selected {
            background: #ede9fe;
        }
        body.dark-theme .meet-multiselect-option.selected {
            background: rgba(109, 40, 217, 0.3);
        }
        .meet-multiselect-checkbox {
            width: 18px;
            height: 18px;
            border: 2px solid #d1d5db;
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }
        .meet-multiselect-option.selected .meet-multiselect-checkbox {
            background: #667eea;
            border-color: #667eea;
        }
        .meet-multiselect-option.selected .meet-multiselect-checkbox::after {
            content: '✓';
            color: white;
            font-size: 12px;
            font-weight: bold;
        }
        .meet-multiselect-info {
            flex: 1;
        }
        .meet-multiselect-name {
            font-weight: 600;
            color: #111827;
        }
        body.dark-theme .meet-multiselect-name {
            color: #f3f4f6;
        }
        .meet-multiselect-meta {
            font-size: 12px;
            color: #6b7280;
            margin-top: 2px;
        }
        body.dark-theme .meet-multiselect-meta {
            color: #9ca3af;
        }
        .meet-selected-chips {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            min-height: 40px;
            padding: 12px;
            background: #f9fafb;
            border-radius: 10px;
            border: 2px dashed #e5e7eb;
        }
        body.dark-theme .meet-selected-chips {
            background: rgba(17, 24, 39, 0.5);
            border-color: rgba(148, 163, 184, 0.3);
        }
        .meet-chip {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            border-radius: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            font-size: 13px;
            font-weight: 500;
            box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
        }
        .meet-chip-remove {
            border: none;
            background: rgba(255, 255, 255, 0.2);
            color: white;
            cursor: pointer;
            font-size: 16px;
            padding: 2px 6px;
            border-radius: 50%;
            line-height: 1;
            transition: background 0.15s ease;
        }
        .meet-chip-remove:hover {
            background: rgba(255, 255, 255, 0.3);
        }
        .meet-empty-state {
            color: #9ca3af;
            font-size: 13px;
            font-style: italic;
        }
        body.dark-theme .meet-empty-state {
            color: #6b7280;
        }
        .meet-btn {
            padding: 14px 28px;
            border: none;
            border-radius: 10px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }
        .meet-btn-primary {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
            width: 100%;
            justify-content: center;
        }
        .meet-btn-primary:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(102, 126, 234, 0.5);
        }
        .meet-btn-primary:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .meet-actions {
            margin-top: 24px;
        }
    </style>

    <div class="meet-container">
        <div class="meet-header">
            <h1><i class="fa-solid fa-video"></i> Start a Meeting</h1>
            <p>Create a Google Meet and invite your team members</p>
        </div>

        <div class="meet-card">
            <h3 style="margin: 0 0 20px 0; font-size: 18px; font-weight: 600;">Meeting Details</h3>
            
            <div class="meet-form-group">
                <label for="meet-title">Meeting Title</label>
                <input type="text" id="meet-title" class="meet-input" placeholder="e.g., Team Standup" value="Team Sync" />
            </div>

            <div class="meet-form-group">
                <label for="meet-description">Description (Optional)</label>
                <textarea id="meet-description" class="meet-textarea" rows="3" placeholder="Add meeting agenda or notes..."></textarea>
            </div>

            <div class="meet-form-group">
                <label for="meet-employee-select">Select Participants</label>
                <div class="meet-multiselect">
                    <input 
                        type="text" 
                        id="meet-employee-select" 
                        class="meet-input" 
                        placeholder="Click to select employees or type to search..."
                        autocomplete="off"
                    />
                    <div id="meet-employee-dropdown" class="meet-multiselect-dropdown"></div>
                </div>
            </div>

            <div class="meet-form-group">
                <label>Selected Participants (<span id="meet-participant-count">0</span>)</label>
                <div id="meet-selected-chips" class="meet-selected-chips">
                    <span class="meet-empty-state">No participants selected yet</span>
                </div>
            </div>

            <div class="meet-actions">
                <button type="button" id="meet-call-btn" class="meet-btn meet-btn-primary" disabled>
                    <i class="fa-solid fa-phone"></i>
                    Start Call & Notify Participants
                </button>
            </div>
        </div>
    </div>

    <div id="meet-call-modal" class="meet-call-modal incoming-call-overlay hidden" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; display: flex; align-items: center; justify-content: center; z-index: 9999;">
        <div class="meet-call-modal-card incoming-call-modal">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <div>
                    <h3 style="margin:0; font-size:18px;">Calling Participants</h3>
                    <p style="margin:4px 0 0; font-size:13px; color:#6b7280;">Notifications sent to all participants</p>
                </div>
                <button type="button" id="meet-call-close" aria-label="Close" style="cursor: pointer; background: transparent; border: none; color: #e5e7eb; font-size: 20px; padding: 8px; border-radius: 8px;">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div id="meet-call-list"></div>
            <div style="margin-top: 12px; display: flex; justify-content: flex-end;">
                <button type="button" id="meet-call-cancel" class="incoming-call-btn incoming-call-btn-decline">
                    <i class="fa-solid fa-phone-slash"></i> End Call
                </button>
            </div>
        </div>
    </div>
    `;

    const app = document.getElementById('app-content');
    if (app) {
        app.innerHTML = getPageContentHTML('Meet', content);
    }

    setTimeout(async () => {
        const API_BASE = apiBase;
        const employeesDirectory = new Map();
        
        const titleInput = document.getElementById('meet-title');
        const descriptionInput = document.getElementById('meet-description');
        const employeeSelectInput = document.getElementById('meet-employee-select');
        const employeeDropdown = document.getElementById('meet-employee-dropdown');
        const selectedChipsContainer = document.getElementById('meet-selected-chips');
        const participantCountEl = document.getElementById('meet-participant-count');
        const callBtn = document.getElementById('meet-call-btn');
        const callModal = document.getElementById('meet-call-modal');
        const callList = document.getElementById('meet-call-list');
        const callCloseBtn = document.getElementById('meet-call-close');
        const callCancelBtn = document.getElementById('meet-call-cancel');

        const selectedEmployees = new Set();
        let allEmployees = [];
        let filteredEmployees = [];
        let currentMeetInfo = null;
        let isDropdownOpen = false;

        // Load employees
        const loadEmployees = async () => {
            try {
                const data = await cachedFetch('meet_employees_all', async () => {
                    const resp = await fetch(`${API_BASE}/api/employees/all`);
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    return await resp.json();
                }, TTL.LONG);
                
                if (data.success && Array.isArray(data.employees)) {
                    allEmployees = data.employees.map(emp => ({
                        id: String(emp.employee_id || '').trim().toUpperCase(),
                        name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
                        email: emp.email || '',
                        designation: emp.designation || '',
                        department: emp.department || ''
                    })).filter(e => e.id);
                    
                    allEmployees.forEach(emp => {
                        employeesDirectory.set(emp.id, emp);
                    });
                    
                    filteredEmployees = [...allEmployees];
                    console.log(`[MEET] Loaded ${allEmployees.length} employees`);
                }
            } catch (err) {
                console.error('[MEET] Failed to load employees:', err);
                showToast('Failed to load employees', 'error');
            }
        };

        // Render dropdown options
        const renderDropdown = () => {
            if (!employeeDropdown) return;
            employeeDropdown.innerHTML = '';
            
            if (filteredEmployees.length === 0) {
                employeeDropdown.innerHTML = '<div style="padding: 12px; text-align: center; color: #9ca3af;">No employees found</div>';
                return;
            }
            
            filteredEmployees.forEach(emp => {
                const option = document.createElement('div');
                option.className = 'meet-multiselect-option';
                if (selectedEmployees.has(emp.id)) {
                    option.classList.add('selected');
                }
                
                option.innerHTML = `
                    <div class="meet-multiselect-checkbox"></div>
                    <div class="meet-multiselect-info">
                        <div class="meet-multiselect-name">${emp.name}</div>
                        <div class="meet-multiselect-meta">${emp.id} • ${emp.designation || 'Employee'}</div>
                    </div>
                `;
                
                option.addEventListener('click', () => toggleEmployee(emp.id));
                employeeDropdown.appendChild(option);
            });
        };

        // Toggle employee selection
        const toggleEmployee = (empId) => {
            if (selectedEmployees.has(empId)) {
                selectedEmployees.delete(empId);
            } else {
                selectedEmployees.add(empId);
            }
            renderDropdown();
            renderSelectedChips();
            updateCallButton();
        };

        // Render selected chips
        const renderSelectedChips = () => {
            if (!selectedChipsContainer) return;
            selectedChipsContainer.innerHTML = '';
            
            if (selectedEmployees.size === 0) {
                selectedChipsContainer.innerHTML = '<span class="meet-empty-state">No participants selected yet</span>';
                if (participantCountEl) participantCountEl.textContent = '0';
                return;
            }
            
            if (participantCountEl) participantCountEl.textContent = String(selectedEmployees.size);
            
            selectedEmployees.forEach(empId => {
                const emp = employeesDirectory.get(empId);
                if (!emp) return;
                
                const chip = document.createElement('div');
                chip.className = 'meet-chip';
                chip.innerHTML = `
                    <span>${emp.name}</span>
                    <button class="meet-chip-remove" data-id="${empId}">×</button>
                `;
                
                const removeBtn = chip.querySelector('.meet-chip-remove');
                removeBtn.addEventListener('click', () => toggleEmployee(empId));
                
                selectedChipsContainer.appendChild(chip);
            });
        };

        // Update call button state
        const updateCallButton = () => {
            if (callBtn) {
                callBtn.disabled = selectedEmployees.size === 0;
            }
        };

        // Filter employees
        const filterEmployees = (searchTerm) => {
            const term = searchTerm.toLowerCase().trim();
            if (!term) {
                filteredEmployees = [...allEmployees];
            } else {
                filteredEmployees = allEmployees.filter(emp => 
                    emp.name.toLowerCase().includes(term) ||
                    emp.id.toLowerCase().includes(term) ||
                    emp.department.toLowerCase().includes(term) ||
                    emp.designation.toLowerCase().includes(term)
                );
            }
            renderDropdown();
        };

        // Toggle dropdown
        const toggleDropdown = () => {
            isDropdownOpen = !isDropdownOpen;
            if (employeeDropdown) {
                employeeDropdown.classList.toggle('active', isDropdownOpen);
            }
        };

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!employeeSelectInput?.contains(e.target) && !employeeDropdown?.contains(e.target)) {
                isDropdownOpen = false;
                if (employeeDropdown) employeeDropdown.classList.remove('active');
            }
        });

        // Event listeners
        if (employeeSelectInput) {
            employeeSelectInput.addEventListener('click', () => {
                toggleDropdown();
            });
            
            employeeSelectInput.addEventListener('input', (e) => {
                if (!isDropdownOpen) {
                    isDropdownOpen = true;
                    employeeDropdown?.classList.add('active');
                }
                filterEmployees(e.target.value);
            });
        }

        // Start call function
        const startCall = async () => {
            if (selectedEmployees.size === 0) {
                showToast('Please select at least one participant', 'warning');
                return;
            }

            const title = titleInput?.value?.trim() || 'Team Sync';
            const description = descriptionInput?.value?.trim() || '';
            const employeeIds = Array.from(selectedEmployees);
            const employeeEmails = employeeIds.map(id => employeesDirectory.get(id)?.email).filter(Boolean);

            callBtn.disabled = true;
            callBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating Meeting...';

            try {
                const payload = {
                    title,
                    description,
                    audience_type: 'employees',
                    employee_ids: employeeIds,
                    employee_emails: employeeEmails,
                    timezone: tz,
                    admin_id: String(state?.user?.id || '').trim() || 'admin'
                };

                const resp = await fetch(`${API_BASE}/api/meet/start`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const data = await resp.json();
                
                if (!resp.ok || !data.success) {
                    throw new Error(data.error || 'Failed to create meeting');
                }

                currentMeetInfo = data;
                showToast('Meeting created! Opening meet link...', 'success');
                
                // Open meet link for host
                if (data.meet_url) {
                    window.open(data.meet_url, '_blank', 'noopener,noreferrer');
                }

                // Show call modal with participant status
                showCallModal();
                
            } catch (err) {
                console.error('[MEET] Failed to start call:', err);
                showToast(err.message || 'Failed to create meeting', 'error');
            } finally {
                callBtn.disabled = selectedEmployees.size === 0;
                callBtn.innerHTML = '<i class="fa-solid fa-phone"></i> Start Call & Notify Participants';
            }
        };

        // Show call modal
        const showCallModal = () => {
            if (!callModal || !callList) return;
            callModal.classList.remove('hidden');
            
            callList.innerHTML = '';
            selectedEmployees.forEach(empId => {
                const emp = employeesDirectory.get(empId);
                if (!emp) return;
                
                const row = document.createElement('div');
                row.style.cssText = 'border: 1px solid rgba(148, 163, 184, 0.35); border-radius: 14px; padding: 12px 14px; margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between;';
                row.innerHTML = `
                    <div>
                        <strong>${emp.name}</strong>
                        <div style="font-size: 12px; color: #6b7280;">${emp.email || emp.id}</div>
                    </div>
                    <span class="badge badge-secondary">Notified</span>
                `;
                callList.appendChild(row);
            });
        };

        // Close call modal
        const closeCallModal = () => {
            if (callModal) callModal.classList.add('hidden');
        };

        if (callBtn) {
            callBtn.addEventListener('click', startCall);
        }

        if (callCloseBtn) {
            callCloseBtn.addEventListener('click', closeCallModal);
        }

        if (callCancelBtn) {
            callCancelBtn.addEventListener('click', closeCallModal);
        }

        // Initialize
        await loadEmployees();
        renderDropdown();
        renderSelectedChips();
        updateCallButton();
    }, 0);
};
