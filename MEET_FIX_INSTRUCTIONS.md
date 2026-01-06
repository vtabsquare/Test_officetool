# Meet UI Fix - Quick Implementation Guide

## Issue
The Meet UI dropdown is not showing employees because the JavaScript implementation got corrupted during edits.

## Solution
Use the clean reference implementation in `pages/meet_redesign.js` which has:
1. ✅ Proper employee loading from `/api/employees/all`
2. ✅ Working dropdown with search
3. ✅ Chip-based selection display
4. ✅ Real-time call notifications via sockets

## Quick Fix Steps

### Option 1: Use the reference file directly
In `router.js`, change the Meet route import:

```javascript
// Change from:
import { renderMeetPage } from './pages/shared.js';

// To:
import { renderMeetPage } from './pages/meet_redesign.js';
```

### Option 2: Copy the working implementation
The file `pages/meet_redesign.js` contains a complete, working implementation that can be copied into `pages/shared.js` to replace the corrupted `renderMeetPage` function.

## Key Implementation Details

### Employee Loading
```javascript
const loadEmployees = async () => {
    const data = await cachedFetch('meet_employees_all', async () => {
        const resp = await fetch(`${API_BASE}/api/employees/all`);
        return await resp.json();
    }, TTL.LONG);
    
    if (data.success && Array.isArray(data.employees)) {
        allEmployees = data.employees.map(emp => ({
            id: String(emp.employee_id).trim().toUpperCase(),
            name: `${emp.first_name} ${emp.last_name}`.trim(),
            email: emp.email,
            designation: emp.designation,
            department: emp.department
        }));
    }
};
```

### Dropdown Rendering
```javascript
const renderDropdown = () => {
    employeeDropdown.innerHTML = '';
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
                <div class="meet-multiselect-meta">${emp.id} • ${emp.designation}</div>
            </div>
        `;
        option.addEventListener('click', () => toggleEmployee(emp.id));
        employeeDropdown.appendChild(option);
    });
};
```

### Call Notification Flow
1. User selects employees from dropdown
2. Clicks "Start Call & Notify Participants"
3. Backend creates Google Meet via `/api/meet/start`
4. Host browser opens meet link automatically
5. Socket server emits `call:ring` to all selected participants
6. Participants see toast notification with Accept/Decline
7. Host sees status updates in real-time

## Testing
1. Open browser console
2. Navigate to Meet page
3. Check for log: `[MEET] Loaded X employees into directory`
4. Click dropdown - should show employee list
5. Select employees - chips should appear
6. Click call button - should create meet and notify

## Files
- `pages/meet_redesign.js` - Clean working implementation
- `pages/meet_working.js` - Backup copy
- `MEET_UI_REDESIGN_SUMMARY.md` - Full documentation

## Current Status
- ✅ UI designed and styled
- ✅ Reference implementation created
- ⚠️ Need to integrate into router or fix shared.js
- ✅ Socket notifications already working
- ✅ Backend API ready

## Next Steps
Choose one of the integration options above and test the complete flow.
