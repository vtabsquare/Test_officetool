// notificationApi.js - Simple notification badge using pending leaves
import { state } from '../state.js';
import { fetchPendingLeaves, fetchEmployeeLeaves } from './leaveApi.js';
import { showLeaveApprovalToast, showLeaveRejectionToast } from '../components/toast.js';

/**
 * Update notification badge count based on pending leaves
 * - Admin: Shows count of pending leave requests (awaiting approval)
 * - Employee: Shows count of their pending requests
 */
let _badgeLastUpdated = 0;
const BADGE_CACHE_TTL = 15000; // 15 seconds
export const updateNotificationBadge = async () => {
    try {
        // Skip if updated recently
        const now = Date.now();
        if (now - _badgeLastUpdated < BADGE_CACHE_TTL) {
            return;
        }

        const employeeId = state.user?.id || state.user?.employee_id;
        const email = state.user?.email || '';
        
        if (!employeeId) {
            return;
        }

        _badgeLastUpdated = now;

        // Check if user is admin
        const isAdmin = employeeId.toUpperCase() === 'EMP001' || email.toLowerCase() === 'bala.t@vtab.com';
        
        let count = 0;
        if (isAdmin) {
            const pendingLeaves = await fetchPendingLeaves();
            const compOffAll = JSON.parse(localStorage.getItem('compoff_requests') || '[]');
            const pendingCompOff = compOffAll.filter(r => (r.status || 'pending').toLowerCase() === 'pending');
            count = (pendingLeaves?.length || 0) + (pendingCompOff.length || 0);
        } else {
            const allLeaves = await fetchEmployeeLeaves(employeeId);
            const myPendingLeaves = allLeaves.filter(l => l.status?.toLowerCase() === 'pending');
            const compOffAll = JSON.parse(localStorage.getItem('compoff_requests') || '[]');
            const myPendingCompOff = compOffAll.filter(r => String(r.employeeId).toUpperCase() === String(employeeId).toUpperCase() && (r.status || 'pending').toLowerCase() === 'pending');
            count = (myPendingLeaves.length || 0) + (myPendingCompOff.length || 0);
        }

        // Update badge
        const badge = document.getElementById('notification-badge');
        if (badge) {
            badge.textContent = count;
            badge.style.display = count > 0 ? 'flex' : 'none';
        }
    } catch (error) {
        console.error('❌ Error updating notification badge:', error);
    }
};

/**
 * Navigate to inbox when bell is clicked
 */
export const handleNotificationBellClick = () => {
    const employeeId = state.user?.id || state.user?.employee_id;
    const email = state.user?.email || '';
    const isAdmin = employeeId?.toUpperCase() === 'EMP001' || email?.toLowerCase() === 'bala.t@vtab.com';
    
    // Navigate to inbox
    window.location.hash = '#/inbox';
    
    console.log('🔔 Navigating to inbox');
};

// Dummy functions for compatibility (no-op since we're not using separate notifications table)
export const notifyAdminLeaveApplication = async () => {
    console.log('📬 Leave application submitted - admin will see in pending requests');
    await updateNotificationBadge();
};

// ---- Comp Off employee notifications ----
export const notifyEmployeeCompOffGranted = async (requestId, employeeId) => {
    const notificationData = {
        type: 'compoff_granted',
        requestId,
        employeeId,
        timestamp: new Date().toISOString(),
        message: `Your Comp Off request (${requestId}) has been granted!`
    };
    const storageKey = `pending_notification_${employeeId}`;
    const existing = JSON.parse(localStorage.getItem(storageKey) || '[]');
    existing.push(notificationData);
    localStorage.setItem(storageKey, JSON.stringify(existing));
    await updateNotificationBadge();
};

export const notifyEmployeeCompOffRejected = async (requestId, employeeId, reason = '') => {
    const notificationData = {
        type: 'compoff_rejected',
        requestId,
        employeeId,
        reason,
        timestamp: new Date().toISOString(),
        message: reason ? `Your Comp Off request (${requestId}) was rejected. Reason: ${reason}` : `Your Comp Off request (${requestId}) was rejected.`
    };
    const storageKey = `pending_notification_${employeeId}`;
    const existing = JSON.parse(localStorage.getItem(storageKey) || '[]');
    existing.push(notificationData);
    localStorage.setItem(storageKey, JSON.stringify(existing));
    await updateNotificationBadge();
};

export const notifyAdminCompOffRequest = async (request) => {
    try {
        const list = JSON.parse(localStorage.getItem('compoff_requests') || '[]');
        const req = { ...request, status: request.status || 'Pending', id: request.id || `CO-${Date.now()}` };
        list.unshift(req);
        localStorage.setItem('compoff_requests', JSON.stringify(list));
        await updateNotificationBadge();
    } catch (e) {}
};

export const notifyEmployeeLeaveApproval = async (leaveId, employeeId, leaveType) => {
    console.log('✅ Leave approved - sending notification to employee');
    
    // Store the notification for immediate display
    const notificationData = {
        type: 'approval',
        leaveId,
        employeeId,
        leaveType,
        timestamp: new Date().toISOString(),
        message: `Your ${leaveType} request (${leaveId}) has been approved!`
    };
    
    // Store in localStorage for the specific employee
    const storageKey = `pending_notification_${employeeId}`;
    const existingNotifications = JSON.parse(localStorage.getItem(storageKey) || '[]');
    existingNotifications.push(notificationData);
    localStorage.setItem(storageKey, JSON.stringify(existingNotifications));
    
    console.log(`📬 Stored approval notification for ${employeeId}:`, notificationData);
    
    await updateNotificationBadge();
};

export const notifyEmployeeLeaveRejection = async (leaveId, employeeId, leaveType, reason = '') => {
    console.log('❌ Leave rejected - sending notification to employee');
    
    // Store the notification for immediate display
    const notificationData = {
        type: 'rejection',
        leaveId,
        employeeId,
        leaveType,
        reason,
        timestamp: new Date().toISOString(),
        message: reason 
            ? `Your ${leaveType} request (${leaveId}) was rejected. Reason: ${reason}`
            : `Your ${leaveType} request (${leaveId}) was rejected.`
    };
    
    // Store in localStorage for the specific employee
    const storageKey = `pending_notification_${employeeId}`;
    const existingNotifications = JSON.parse(localStorage.getItem(storageKey) || '[]');
    existingNotifications.push(notificationData);
    localStorage.setItem(storageKey, JSON.stringify(existingNotifications));
    
    console.log(`📬 Stored rejection notification for ${employeeId}:`, notificationData);
    
    await updateNotificationBadge();
};

/**
 * Check for new leave status changes and show toast notifications
 * Called when user logs in or navigates to dashboard
 */
export const checkForNewLeaveNotifications = async () => {
    try {
        const employeeId = state.user?.id || state.user?.employee_id;
        const email = state.user?.email || '';
        
        if (!employeeId) return;
        
        // Skip for admin users
        const isAdmin = employeeId.toUpperCase() === 'EMP001' || email.toLowerCase() === 'bala.t@vtab.com';
        if (isAdmin) return;
        
        console.log('🔔 Checking for new leave notifications...');
        
        // PRIORITY 1: Check for immediate notifications from admin actions
        const pendingStorageKey = `pending_notification_${employeeId}`;
        const pendingNotifications = JSON.parse(localStorage.getItem(pendingStorageKey) || '[]');
        
        if (pendingNotifications.length > 0) {
            console.log(`🚨 Found ${pendingNotifications.length} immediate notifications!`);
            
            // Show toast for each pending notification
            for (const notification of pendingNotifications) {
                if (notification.type === 'approval') {
                    showLeaveApprovalToast(notification.leaveType, notification.leaveId);
                } else if (notification.type === 'rejection') {
                    showLeaveRejectionToast(
                        notification.leaveType, 
                        notification.leaveId, 
                        notification.reason || ''
                    );
                }
                
                console.log(`📬 Displayed notification:`, notification.message);
            }
            
            // Clear the pending notifications after showing them
            localStorage.removeItem(pendingStorageKey);
            console.log('🧹 Cleared pending notifications');
            return; // Exit early since we found immediate notifications
        }
        
        // PRIORITY 2: Fallback to checking leave status changes (existing logic)
        console.log('📋 No immediate notifications, checking leave status changes...');
        
        // Get all employee leaves
        const allLeaves = await fetchEmployeeLeaves(employeeId);
        const completedLeaves = allLeaves.filter(l => 
            l.status?.toLowerCase() === 'approved' || l.status?.toLowerCase() === 'rejected'
        );
        
        // Find leaves that were completed recently and not yet notified
        const newNotifications = completedLeaves.filter(leave => {
            const leaveKey = `${leave.leave_id}_${leave.status}`;
            const wasNotified = localStorage.getItem(`notified_${leaveKey}`);
            return !wasNotified;
        });
        
        console.log(`🔔 Found ${newNotifications.length} status change notifications`);
        
        // Show toast notifications for new status changes
        for (const leave of newNotifications) {
            const leaveKey = `${leave.leave_id}_${leave.status}`;
            
            if (leave.status?.toLowerCase() === 'approved') {
                showLeaveApprovalToast(leave.leave_type, leave.leave_id);
            } else if (leave.status?.toLowerCase() === 'rejected') {
                showLeaveRejectionToast(
                    leave.leave_type, 
                    leave.leave_id, 
                    leave.rejection_reason || ''
                );
            }
            
            // Mark as notified
            localStorage.setItem(`notified_${leaveKey}`, 'true');
        }
        
    } catch (error) {
        console.error('❌ Error checking leave notifications:', error);
    }
};

/**
 * Clear notification history (for testing or reset)
 */
export const clearNotificationHistory = () => {
    const employeeId = state.user?.id || state.user?.employee_id;
    if (!employeeId) return;
    
    // Clear all notification-related localStorage items
    Object.keys(localStorage).forEach(key => {
        if (key.startsWith('leave_notifications_') || key.startsWith('notified_')) {
            localStorage.removeItem(key);
        }
    });
    
    console.log('🧹 Notification history cleared');
};

/**
 * Start periodic notification checking for real-time updates
 * Call this when user logs in to check for notifications every 30 seconds
 */
export const startNotificationPolling = () => {
    // Clear any existing interval
    if (window.notificationInterval) {
        clearInterval(window.notificationInterval);
    }
    
    // Check immediately
    checkForNewLeaveNotifications();
    
    // Then check every 30 seconds
    window.notificationInterval = setInterval(async () => {
        try {
            await checkForNewLeaveNotifications();
        } catch (error) {
            console.warn('⚠️ Periodic notification check failed:', error);
        }
    }, 30000); // 30 seconds
    
    console.log('🔄 Started notification polling (every 30 seconds)');
};

/**
 * Stop periodic notification checking
 */
export const stopNotificationPolling = () => {
    if (window.notificationInterval) {
        clearInterval(window.notificationInterval);
        window.notificationInterval = null;
        console.log('⏹️ Stopped notification polling');
    }
};
