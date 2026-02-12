"""
Debug script to check attendance data consistency on production
Run this on the DigitalOcean droplet
"""

import requests
import json
from datetime import datetime

BASE_URL = "http://localhost:5000/api"

def debug_attendance_data(employee_id="EMP019"):
    print("=" * 80)
    print("ATTENDANCE DATA DEBUG")
    print("=" * 80)
    
    today = datetime.now()
    today_str = today.strftime("%Y-%m-%d")
    
    # Test current status from v2 API
    print("\n1. Checking current status from v2 API:")
    try:
        resp = requests.get(f"{BASE_URL}/v2/attendance/status/{employee_id}?timezone=Asia/Calcutta")
        if resp.status_code == 200:
            data = resp.json()
            print(f"   Success: {data.get('success')}")
            print(f"   Attendance Date: {data.get('attendance_date')}")
            print(f"   Has Record: {data.get('has_record')}")
            print(f"   Is Active: {data.get('is_active_session')}")
            if 'timing' in data:
                print(f"   Check-in: {data['timing'].get('checkin_utc')}")
                print(f"   Check-out: {data['timing'].get('checkout_utc')}")
                print(f"   Total Seconds: {data['timing'].get('total_seconds_today')}")
        else:
            print(f"   Error: {resp.status_code} - {resp.text}")
    except Exception as e:
        print(f"   Exception: {e}")
    
    # Test monthly attendance from old API
    print("\n2. Checking monthly attendance from old API:")
    try:
        resp = requests.get(f"{BASE_URL}/attendance/{employee_id}/{today.year}/{today.month}")
        if resp.status_code == 200:
            data = resp.json()
            print(f"   Success: {data.get('success')}")
            records = data.get('records', [])
            print(f"   Total Records: {len(records)}")
            
            # Find today's record
            today_record = None
            for rec in records:
                if rec.get('date') == today_str:
                    today_record = rec
                    break
            
            if today_record:
                print(f"\n   Today's Record ({today_str}):")
                print(f"   - Day: {today_record.get('day')}")
                print(f"   - CheckIn: {today_record.get('checkIn')}")
                print(f"   - CheckOut: {today_record.get('checkOut')}")
                print(f"   - Duration: {today_record.get('duration')}")
                print(f"   - Status: {today_record.get('status')}")
                print(f"   - Live Augmented: {today_record.get('liveAugmented')}")
            else:
                print(f"\n   No record found for today ({today_str})")
                
            # Show last 3 days
            print(f"\n   Last 3 days records:")
            for rec in records[-3:]:
                print(f"   - {rec.get('date')}: In={rec.get('checkIn')} Out={rec.get('checkOut')} Dur={rec.get('duration')}")
        else:
            print(f"   Error: {resp.status_code} - {resp.text}")
    except Exception as e:
        print(f"   Exception: {e}")
    
    # Test login events
    print("\n3. Checking login events:")
    try:
        resp = requests.get(f"{BASE_URL}/login-events/{employee_id}?from={today_str}&to={today_str}")
        if resp.status_code == 200:
            data = resp.json()
            print(f"   Success: {data.get('success')}")
            daily_summary = data.get('daily_summary', [])
            if daily_summary:
                summary = daily_summary[0]
                print(f"   Date: {summary.get('date')}")
                print(f"   Check In: {summary.get('check_in_time')}")
                print(f"   Check Out: {summary.get('check_out_time')}")
                print(f"   Total Duration: {summary.get('total_duration')}")
                print(f"   Events Count: {summary.get('events_count')}")
            else:
                print("   No login events found for today")
        else:
            print(f"   Error: {resp.status_code} - {resp.text}")
    except Exception as e:
        print(f"   Exception: {e}")

if __name__ == "__main__":
    debug_attendance_data()
