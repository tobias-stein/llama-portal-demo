import os
import boto3
import json
import uuid
from datetime import date, time, timedelta, datetime
from collections import defaultdict
from botocore.exceptions import ClientError

TABLE_NAME = os.environ.get('TABLE_NAME', 'LlamaBookings')

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)
booking_ttl=90

def get_allocations_for_range(start_date, end_date):
    """
    Efficiently fetches all room allocations within a given date range.
    Returns a lookup map: { "YYYY-MM-DD": {"room-id-1", "room-id-2"} }
    """
    months = set()
    current = start_date
    while current < end_date:
        months.add(current.strftime("%Y-%m"))
        next_month = (current.replace(day=28) + timedelta(days=4)).replace(day=1)
        current = next_month

    daily_booked_rooms = defaultdict(set)
    for month_str in months:
        response = table.query(
            IndexName="GSI2",
            KeyConditionExpression="GSI2PK = :pk AND GSI2SK BETWEEN :start AND :end",
            ExpressionAttributeValues={
                ":pk": f"DATE#{month_str}",
                ":start": f"DATE#{start_date.isoformat()}",
                ":end": f"DATE#{(end_date - timedelta(days=1)).isoformat()}#z"
            }
        )
        for item in response.get("Items", []):
            room_id = item["PK"].replace("ROOM#", "")
            alloc_date = item["allocationDate"]
            daily_booked_rooms[alloc_date].add(room_id)
            
    return daily_booked_rooms

def get_consecutive_free_days(room_id, start_date, end_date, daily_booked_rooms):
    """
    Lookahead function: calculates how many continuous days a room is free 
    from the given start date until it hits a booked day or the checkout date.
    """
    count = 0
    current = start_date
    while current < end_date:
        if room_id in daily_booked_rooms.get(current.isoformat(), set()):
            break
        count += 1
        current += timedelta(days=1)
    return count


def lambda_handler(event, context):

    try:
        booking_id = str(uuid.uuid4())
        checkin = date.fromisoformat(event["checkin"])
        checkout = date.fromisoformat(event["checkout"])
        
        # max stay of 90 days
        if (checkout - checkin).days > 90:
            return {"statusCode": 400, "body": "Checkout date is too far in the future."}
        
        guests = int(event["guests"])
        ttl = int(datetime.combine(checkout + timedelta(days=booking_ttl), time.min).timestamp())

        if checkout <= checkin:
            raise ValueError("Checkout date must be after check-in date.")

        allocated_transactions =[]

        # --------------------------
        # 1. Fetch ALL rooms
        # --------------------------
        all_rooms = table.query(
            IndexName="GSI1",
            KeyConditionExpression="GSI1PK = :pk",
            ExpressionAttributeValues={":pk": "ROOMS"}
        ).get("Items",[])
        if not all_rooms:
            raise Exception("No rooms are configured in the system.")

        # --------------------------
        # 2. Fetch all EXISTING allocations for the required date range
        # --------------------------
        daily_booked_rooms = get_allocations_for_range(checkin, checkout)

        # --------------------------
        # 3. Simulate allocation with Partial Reuse & Lookahead
        # --------------------------
        daily_allocation_plan = {}
        previous_day_room_ids =[]

        current_day = checkin
        while current_day < checkout:
            date_str = current_day.isoformat()
            booked_on_this_date = daily_booked_rooms.get(date_str, set())
            
            assigned_rooms =[]
            assigned_capacity = 0
            
            # STRATEGY A: Partial Reuse
            # Keep rooms from yesterday that are still available today.
            for room_id in previous_day_room_ids:
                if room_id not in booked_on_this_date:
                    # Only keep adding carried-over rooms if we haven't met capacity yet
                    if assigned_capacity < guests:
                        room_obj = next((r for r in all_rooms if r["id"] == room_id), None)
                        if room_obj:
                            assigned_rooms.append(room_obj)
                            assigned_capacity += int(room_obj["capacity"])
            
            # STRATEGY B: Fill Deficit with Lookahead
            # If carried-over rooms aren't enough, find the BEST new rooms
            if assigned_capacity < guests:
                carried_over_ids = {r["id"] for r in assigned_rooms}
                available_candidates = [
                    r for r in all_rooms 
                    if r["id"] not in booked_on_this_date and r["id"] not in carried_over_ids
                ]
                
                # Score candidates based on how long they remain free
                for r in available_candidates:
                    r["_free_days"] = get_consecutive_free_days(r["id"], current_day, checkout, daily_booked_rooms)
                
                # Sort prioritizing stability: Longest free streak first, then largest capacity
                available_candidates.sort(key=lambda r: (r["_free_days"], int(r["capacity"])), reverse=True)
                
                for r in available_candidates:
                    if assigned_capacity < guests:
                        assigned_rooms.append(r)
                        assigned_capacity += int(r["capacity"])
                    else:
                        break

            if assigned_capacity < guests:
                raise Exception(f"Not enough capacity for {guests} guests on {date_str}")
            
            # Cleanup & prepare for next iteration
            # Sort assigned rooms descending by capacity so we prefer carrying over bigger rooms
            assigned_rooms.sort(key=lambda r: int(r["capacity"]), reverse=True)
            previous_day_room_ids = [r["id"] for r in assigned_rooms]
            daily_allocation_plan[date_str] = previous_day_room_ids
            
            current_day += timedelta(days=1)
        
        # --------------------------
        # 4. Write booking record with all unique rooms used
        # --------------------------
        all_unique_room_ids = sorted(list(set(
            room_id for day_plan in daily_allocation_plan.values() for room_id in day_plan
        )))

        table.put_item(
            Item={
                "PK": f"BOOKING#{booking_id}", 
                "SK": "META", 
                "entity": "Booking",
                "status": "PENDING", 
                "email": event["email"], 
                "name": event["name"],
                "guests": guests, 
                "checkin": event["checkin"], 
                "checkout": event["checkout"],
                "notes": event.get("notes", ""),
                "createdAt": datetime.utcnow().isoformat() + "Z",
                "roomIds": all_unique_room_ids,
                "ttl": ttl,
                'GSI2PK': event['email'].lower(),
                'GSI2SK': event.get("invitationCode", "")
            }
        )

        # --------------------------
        # 5. Commit allocations
        # --------------------------
        for date_str, room_ids in daily_allocation_plan.items():
            month_str = date_str[:7]
            for room_id in room_ids:
                try:
                    table.put_item(
                        Item={
                            "PK": f"ROOM#{room_id}", 
                            "SK": f"DATE#{date_str}",
                            "entity": "Allocation", 
                            "bookingId": booking_id,
                            "allocationDate": date_str, 
                            "GSI1PK": f"BOOKING#{booking_id}",
                            "GSI1SK": f"DATE#{date_str}", 
                            "GSI2PK": f"DATE#{month_str}", 
                            "GSI2SK": f"DATE#{date_str}#ROOM#{room_id}",
                            "ttl": ttl
                        },
                        ConditionExpression="attribute_not_exists(PK)"
                    )
                    allocated_transactions.append((room_id, date_str))
                except ClientError as e:
                    if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                        raise Exception(f"Concurrency error: Room {room_id} was booked on {date_str}.")
                    else:
                        raise
        
        return {"statusCode": 200, "body": json.dumps({"bookingId": booking_id})}

    except Exception as e:
        # Full rollback
        if 'booking_id' in locals():
            table.delete_item(Key={"PK": f"BOOKING#{booking_id}", "SK": "META"})
        for room_id, date_str in allocated_transactions:
            table.delete_item(Key={"PK": f"ROOM#{room_id}", "SK": f"DATE#{date_str}"})
        return {"statusCode": 400, "body": json.dumps({"error": str(e)})}